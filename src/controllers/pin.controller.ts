import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { invalidateAuthCache } from '../middleware/auth.middleware';
import { completeLogin } from '../services/loginSession.service';
import {
  LOCK_MINUTES,
  isPinFormat, weakPinReason, hashSecret, compareSecret, burnCompareTime,
  pinStateOf, lockMinutesLeft, recordFailure, clearFailures,
} from '../services/pin.service';

const PHONE_RE = /^[6-9]\d{9}$/;

const BAD_CODE_MESSAGE = 'That code is not valid or has expired. Please ask your Secretary for a new one.';
const BAD_LOGIN_MESSAGE = 'Incorrect phone number or PIN.';

function cleanPhone(value: unknown): string {
  return String(value ?? '').trim().replace(/[^0-9]/g, '');
}

/** Guards use their own wing + PIN login; removed accounts can't sign in at all. */
async function findLoginUser(phone: string) {
  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user || !user.isActive || user.role === 'GUARD') return null;
  return user;
}

function lockedResponse(res: Response, minutes: number) {
  return res.status(429).json({
    success: false,
    code: 'LOCKED',
    message: `Too many wrong attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
  });
}

// ─── Step 1: what should the login screen show for this number? ──────────────
// Unknown numbers get the same answer as normal accounts ("PIN"), so the
// endpoint can't be used to find out who lives in a society.
export async function handleCheckPhone(req: Request, res: Response) {
  const phone = cleanPhone(req.body?.phone);
  if (!PHONE_RE.test(phone)) {
    return res.status(400).json({ success: false, message: 'Enter a valid 10-digit mobile number.' });
  }
  const user = await findLoginUser(phone);
  const status = user ? pinStateOf(user) : 'PIN';
  return res.json({ success: true, data: { status } });
}

// ─── First login: activation code + choose a PIN ─────────────────────────────
const activateSchema = z.object({
  phone: z.string(),
  code: z.string(),
  pin: z.string(),
  device_id: z.string().optional(),
});

export async function handleActivate(req: Request, res: Response) {
  const parsed = activateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Phone, code and PIN are required.' });

  const phone = cleanPhone(parsed.data.phone);
  const code = parsed.data.code.replace(/\s+/g, '');
  const pin = parsed.data.pin;

  if (!PHONE_RE.test(phone)) return res.status(400).json({ success: false, message: 'Enter a valid 10-digit mobile number.' });
  if (!/^\d{8}$/.test(code)) return res.status(400).json({ success: false, message: 'The activation code has 8 digits.' });
  const weak = weakPinReason(pin);
  if (weak) return res.status(400).json({ success: false, message: weak });

  const user = await findLoginUser(phone);
  if (!user) {
    await burnCompareTime(code);
    return res.status(400).json({ success: false, message: BAD_CODE_MESSAGE });
  }

  const lockLeft = lockMinutesLeft(user);
  if (lockLeft > 0) return lockedResponse(res, lockLeft);

  const hasLiveCode =
    !!user.activationCodeHash && !!user.activationExpiresAt && user.activationExpiresAt.getTime() > Date.now();
  if (!hasLiveCode) {
    await burnCompareTime(code);
    return res.status(400).json({ success: false, message: BAD_CODE_MESSAGE });
  }

  const matches = await compareSecret(code, user.activationCodeHash!);
  if (!matches) {
    const { locked, attemptsLeft } = await recordFailure(user.id);
    if (locked) return lockedResponse(res, LOCK_MINUTES);
    return res.status(400).json({
      success: false,
      message: `${BAD_CODE_MESSAGE} (${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left)`,
    });
  }

  // Code is correct: it can never be used again, and the chosen PIN is stored hashed.
  await prisma.user.update({
    where: { id: user.id },
    data: {
      pinHash: await hashSecret(pin),
      pinSetAt: new Date(),
      activationCodeHash: null,
      activationExpiresAt: null,
      pinFailedAttempts: 0,
      pinLockedUntil: null,
    },
  });
  invalidateAuthCache(user.id);

  const data = await completeLogin(user, { deviceId: req.body?.device_id });
  return res.json({ success: true, message: 'Your PIN is set. Welcome!', data });
}

// ─── Everyday login: phone + PIN ─────────────────────────────────────────────
const loginSchema = z.object({
  phone: z.string(),
  pin: z.string(),
  device_id: z.string().optional(),
});

export async function handlePinLogin(req: Request, res: Response) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Phone and PIN are required.' });

  const phone = cleanPhone(parsed.data.phone);
  const pin = parsed.data.pin;
  if (!PHONE_RE.test(phone)) return res.status(400).json({ success: false, message: 'Enter a valid 10-digit mobile number.' });
  if (!isPinFormat(pin)) return res.status(400).json({ success: false, message: 'Your PIN has 6 digits.' });

  const user = await findLoginUser(phone);
  if (!user) {
    await burnCompareTime(pin);
    return res.status(401).json({ success: false, message: BAD_LOGIN_MESSAGE });
  }

  const lockLeft = lockMinutesLeft(user);
  if (lockLeft > 0) return lockedResponse(res, lockLeft);

  if (!user.pinHash) {
    // Not activated yet (or the PIN was reset): the app sends them to the activation screen.
    return res.status(409).json({
      success: false,
      code: 'NEEDS_ACTIVATION',
      state: pinStateOf(user),
      message: 'This account is not activated yet. Use the activation code from your Secretary.',
    });
  }

  const matches = await compareSecret(pin, user.pinHash);
  if (!matches) {
    const { locked, attemptsLeft } = await recordFailure(user.id);
    if (locked) return lockedResponse(res, LOCK_MINUTES);
    return res.status(401).json({
      success: false,
      message: `${BAD_LOGIN_MESSAGE} ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left.`,
    });
  }

  if (user.pinFailedAttempts > 0 || user.pinLockedUntil) await clearFailures(user.id);

  const data = await completeLogin(user, { deviceId: req.body?.device_id });
  return res.json({ success: true, message: 'Login successful', data });
}

// ─── Change PIN (signed in) ──────────────────────────────────────────────────
const changeSchema = z.object({
  current_pin: z.string(),
  new_pin: z.string(),
  device_id: z.string().optional(),
});

export async function handleChangePin(req: Request, res: Response) {
  const parsed = changeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, message: 'Current PIN and new PIN are required.' });

  const { current_pin, new_pin } = parsed.data;
  if (!isPinFormat(current_pin)) return res.status(400).json({ success: false, message: 'Your current PIN has 6 digits.' });
  const weak = weakPinReason(new_pin);
  if (weak) return res.status(400).json({ success: false, message: weak });
  if (current_pin === new_pin) return res.status(400).json({ success: false, message: 'Your new PIN must be different from the current one.' });

  const user = await prisma.user.findUnique({ where: { id: req.user.user_id } });
  if (!user || !user.isActive || !user.pinHash) {
    return res.status(400).json({ success: false, message: 'Could not change the PIN for this account.' });
  }

  const lockLeft = lockMinutesLeft(user);
  if (lockLeft > 0) return lockedResponse(res, lockLeft);

  const matches = await compareSecret(current_pin, user.pinHash);
  if (!matches) {
    const { locked, attemptsLeft } = await recordFailure(user.id);
    if (locked) return lockedResponse(res, LOCK_MINUTES);
    return res.status(400).json({
      success: false,
      message: `Your current PIN is incorrect. ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left.`,
    });
  }

  // New PIN: every other login (other phones, other browsers) is signed out.
  await prisma.user.update({
    where: { id: user.id },
    data: {
      pinHash: await hashSecret(new_pin),
      pinSetAt: new Date(),
      pinFailedAttempts: 0,
      pinLockedUntil: null,
      sessionsValidAfter: new Date(),
    },
  });
  await prisma.session.deleteMany({ where: { userId: user.id } });
  invalidateAuthCache(user.id);

  const data = await completeLogin(user, { deviceId: parsed.data.device_id });
  return res.json({ success: true, message: 'PIN changed. Other devices were signed out.', data });
}


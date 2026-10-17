import bcrypt from 'bcrypt';
import { randomInt, randomUUID } from 'crypto';
import { prisma } from '../config/db';
import { invalidateAuthCache } from '../middleware/auth.middleware';

// ─── Rules ───────────────────────────────────────────────────────────────────
export const PIN_LENGTH = 6;
export const ACTIVATION_VALID_DAYS = 7;
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;

const BCRYPT_ROUNDS = 10;

// ─── PIN format ──────────────────────────────────────────────────────────────
export function isPinFormat(pin: unknown): pin is string {
  return typeof pin === 'string' && /^\d{6}$/.test(pin);
}

/** Returns an error message if the PIN is too easy to guess, otherwise null. */
export function weakPinReason(pin: string): string | null {
  if (!isPinFormat(pin)) return `PIN must be exactly ${PIN_LENGTH} digits`;
  if (/^(\d)\1{5}$/.test(pin)) return 'Choose a PIN that is harder to guess (not all the same digit).';
  const digits = pin.split('').map(Number);
  const ascending = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
  const descending = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
  if (ascending || descending) return 'Choose a PIN that is harder to guess (not a simple sequence).';
  return null;
}

// ─── Hashing ─────────────────────────────────────────────────────────────────
export const hashSecret = (plain: string) => bcrypt.hash(plain, BCRYPT_ROUNDS);
export const compareSecret = (plain: string, hash: string) => bcrypt.compare(plain, hash);

// A real hash used to burn the same time when the phone isn't registered, so
// response timing doesn't reveal which numbers exist.
const DUMMY_HASH = bcrypt.hashSync('000000-dummy', BCRYPT_ROUNDS);
export async function burnCompareTime(plain: string) {
  await bcrypt.compare(plain, DUMMY_HASH);
}

// ─── Activation codes ────────────────────────────────────────────────────────
export function generateActivationCode(): string {
  return String(randomInt(10_000_000, 100_000_000)); // 8 digits, never starts with 0
}

export function formatActivationCode(code: string): string {
  return `${code.slice(0, 4)} ${code.slice(4)}`;
}

export interface IssuedCode {
  userId: string;
  /** Shown once to whoever hands it over — never stored in readable form. */
  code: string;
  formatted: string;
  expiresAt: Date;
}

/**
 * Creates a fresh one-time activation code for a person.
 *
 * `resetPin: true` is used when a PIN is forgotten / an account is handed over:
 * the old PIN is wiped and every existing login on every device is signed out.
 * For brand-new accounts there is nothing to wipe, so it can be left false.
 */
export async function issueActivationCode(
  userId: string,
  opts: { resetPin?: boolean } = {},
): Promise<IssuedCode> {
  const code = generateActivationCode();
  const expiresAt = new Date(Date.now() + ACTIVATION_VALID_DAYS * 24 * 60 * 60 * 1000);

  const data: Record<string, unknown> = {
    activationCodeHash: await hashSecret(code),
    activationExpiresAt: expiresAt,
    pinFailedAttempts: 0,
    pinLockedUntil: null,
  };
  if (opts.resetPin) {
    data.pinHash = null;
    data.pinSetAt = null;
    data.sessionsValidAfter = new Date();
    data.sessionId = randomUUID(); // signs out every mobile login immediately
  }

  await prisma.user.update({ where: { id: userId }, data: data as any });
  if (opts.resetPin) {
    await prisma.session.deleteMany({ where: { userId } });
  }
  invalidateAuthCache(userId);

  return { userId, code, formatted: formatActivationCode(code), expiresAt };
}

// ─── Account state ───────────────────────────────────────────────────────────
export type PinState = 'PIN' | 'ACTIVATE' | 'NEEDS_CODE';

export function pinStateOf(user: {
  pinHash: string | null;
  activationCodeHash: string | null;
  activationExpiresAt: Date | null;
}): PinState {
  if (user.pinHash) return 'PIN';
  if (user.activationCodeHash && user.activationExpiresAt && user.activationExpiresAt.getTime() > Date.now()) {
    return 'ACTIVATE';
  }
  return 'NEEDS_CODE';
}

/** Safe summary for the Secretary / Super Admin screens (no hashes). */
export function pinSummaryOf(user: {
  pinSetAt: Date | null;
  activationCodeHash: string | null;
  activationExpiresAt: Date | null;
}) {
  const pending = !!user.activationCodeHash && !!user.activationExpiresAt && user.activationExpiresAt.getTime() > Date.now();
  const expired = !!user.activationCodeHash && !!user.activationExpiresAt && user.activationExpiresAt.getTime() <= Date.now();
  return {
    status: user.pinSetAt ? 'ACTIVE' : pending ? 'CODE_PENDING' : expired ? 'CODE_EXPIRED' : 'NOT_ACTIVATED',
    activationExpiresAt: pending ? user.activationExpiresAt : null,
  } as const;
}

// ─── Lockout ─────────────────────────────────────────────────────────────────
export function lockMinutesLeft(user: { pinLockedUntil: Date | null }): number {
  if (!user.pinLockedUntil) return 0;
  const ms = user.pinLockedUntil.getTime() - Date.now();
  return ms > 0 ? Math.ceil(ms / 60_000) : 0;
}

/** Counts a wrong PIN / code. Locks the account for 15 minutes on the 5th miss. */
export async function recordFailure(userId: string): Promise<{ locked: boolean; attemptsLeft: number }> {
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { pinFailedAttempts: { increment: 1 } },
    select: { pinFailedAttempts: true },
  });
  if (updated.pinFailedAttempts >= MAX_FAILED_ATTEMPTS) {
    await prisma.user.update({
      where: { id: userId },
      data: { pinFailedAttempts: 0, pinLockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) },
    });
    return { locked: true, attemptsLeft: 0 };
  }
  return { locked: false, attemptsLeft: MAX_FAILED_ATTEMPTS - updated.pinFailedAttempts };
}

export async function clearFailures(userId: string) {
  await prisma.user.update({ where: { id: userId }, data: { pinFailedAttempts: 0, pinLockedUntil: null } });
}

// ─── Phone ownership guard (used when accounts are created by an admin) ─────
/**
 * Stops an admin's "add person" action from silently taking over an account
 * that belongs to someone else (another wing, a platform admin, a guard…).
 * Returns an error message, or null when the phone is free to use.
 */
export function phoneConflict(
  existing: { role: string; wingId: string | null; isActive: boolean } | null,
  wanted: { role: string; wingId: string },
): string | null {
  if (!existing) return null;
  if (existing.role === 'SUPER_ADMIN') return 'This phone number belongs to a platform administrator.';
  if (!existing.isActive) return null; // removed earlier — may rejoin (gets a fresh code)
  if (existing.wingId && existing.wingId !== wanted.wingId) {
    return 'This phone number is already registered in another wing or society.';
  }
  if (existing.role !== wanted.role) return 'This phone number is already registered to another user.';
  return null;
}

/**
 * After an admin creates/updates an account, decides whether a fresh activation
 * code is needed: new account, re-joining account, or one that never got a PIN.
 * People who already have a working PIN are never touched.
 */
export async function codeIfNeeded(
  userId: string,
  before: { isActive: boolean; pinHash: string | null } | null,
): Promise<IssuedCode | null> {
  const isNewOrRejoining = !before || !before.isActive;
  if (isNewOrRejoining) return issueActivationCode(userId, { resetPin: !!before });
  if (!before.pinHash) {
    const fresh = await prisma.user.findUnique({
      where: { id: userId },
      select: { activationCodeHash: true, activationExpiresAt: true },
    });
    const stillValid = !!fresh?.activationCodeHash && !!fresh.activationExpiresAt && fresh.activationExpiresAt.getTime() > Date.now();
    if (!stillValid) return issueActivationCode(userId);
  }
  return null;
}

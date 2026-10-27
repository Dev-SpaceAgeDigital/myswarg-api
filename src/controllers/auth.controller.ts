import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { signToken, verifyToken } from '../utils/jwt';
import { ok, badRequest, unauthorized } from '../utils/response';
import { hashSecret, compareSecret, burnCompareTime } from '../services/pin.service';
import { normaliseSocietyCode } from '../services/societyCode.service';

const guardLoginSchema = z.object({
  society_code: z.string().min(4).max(12),
  pin: z.string().regex(/^\d{4,6}$/, 'Enter your PIN'),
});

const refreshSchema = z.object({
  refresh_token: z.string().min(1),
});

// Society code + the guard's own PIN. The PIN tells guards of the same society
// apart, so no wing has to be chosen; a guard covering every tower sees all of them.
export async function handleGuardLogin(req: Request, res: Response) {
  if (req.body?.wing_code && !req.body?.society_code) {
    return badRequest(res, 'Please update the MySwarg app to sign in as a guard.');
  }
  const parsed = guardLoginSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.errors[0].message);

  const code = normaliseSocietyCode(parsed.data.society_code);
  const { pin } = parsed.data;

  const society = await prisma.society.findUnique({ where: { code }, select: { id: true } });
  if (!society) {
    await burnCompareTime(pin);
    return unauthorized(res, 'Incorrect society code or PIN.');
  }

  const guards = await prisma.user.findMany({
    where: { role: 'GUARD', isActive: true, OR: [{ societyId: society.id }, { wing: { societyId: society.id } }] },
    select: { id: true, role: true, name: true, societyId: true, wingId: true, guardPin: true, guardPinHash: true },
  });

  const matches: typeof guards = [];
  for (const g of guards) {
    if (g.guardPinHash ? await compareSecret(pin, g.guardPinHash) : (!!g.guardPin && g.guardPin === pin)) matches.push(g);
  }
  if (matches.length > 1) {
    // Only possible with old PINs set before they had to be unique.
    return badRequest(res, 'This PIN is used by more than one guard. Please ask your Secretary to set you a new PIN.');
  }
  const guard = matches[0];
  if (!guard) {
    if (!guards.length) await burnCompareTime(pin);
    return unauthorized(res, 'Incorrect society code or PIN.');
  }
  if (!guard.guardPinHash) {
    // Older account: move the PIN to hashed storage on this first sign-in.
    await prisma.user.update({ where: { id: guard.id }, data: { guardPinHash: await hashSecret(pin), guardPin: null } });
  }

  const token = signToken({
    user_id: guard.id,
    role: guard.role,
    society_id: guard.societyId ?? society.id,
    wing_id: guard.wingId ?? '',
    flat_id: null,
    name: guard.name,
  });

  return ok(res, { token, role: 'GUARD' }, 'Guard login successful');
}

export async function handleRefresh(req: Request, res: Response) {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.errors[0].message);

  const { refresh_token } = parsed.data;

  let payload: { user_id: string };
  try {
    payload = verifyToken(refresh_token) as { user_id: string };
  } catch {
    return unauthorized(res, 'Invalid refresh token');
  }

  const session = await prisma.session.findFirst({ where: { sessionToken: refresh_token } });
  if (!session) return unauthorized(res, 'Session not found');

  const user = await prisma.user.findUnique({ where: { id: payload.user_id } });
  if (!user || !user.isActive) return unauthorized(res, 'User not found');

  await prisma.session.update({ where: { id: session.id }, data: { lastActive: new Date() } });

  const token = signToken({
    user_id: user.id,
    role: user.role,
    society_id: user.societyId ?? '',
    wing_id: user.wingId ?? '',
    flat_id: user.flatId,
    is_primary: user.isPrimary,
    name: user.name,
    sid: user.sessionId ?? undefined,
  });

  return ok(res, { token }, 'Token refreshed');
}

export async function handleLogout(req: Request, res: Response) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(' ')[1];
  if (!token) return badRequest(res, 'No token provided');

  const refresh_token = req.body?.refresh_token as string | undefined;
  if (refresh_token) {
    await prisma.session.deleteMany({ where: { sessionToken: refresh_token } });
  }

  // Stop phone alerts for this person on this phone once they sign out.
  await prisma.user.updateMany({ where: { id: req.user.user_id }, data: { pushToken: null } });

  return ok(res, null, 'Logged out successfully');
}

import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { signToken, verifyToken } from '../utils/jwt';
import { ok, badRequest, unauthorized } from '../utils/response';

const guardLoginSchema = z.object({
  wing_code: z.string().min(1),
  pin: z.string().length(4),
});

const refreshSchema = z.object({
  refresh_token: z.string().min(1),
});

export async function handleGuardLogin(req: Request, res: Response) {
  const parsed = guardLoginSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.errors[0].message);

  const { wing_code, pin } = parsed.data;

  // Look up guard directly in DB — wing name matched case-insensitively,
  // guardPin stored on the User record (set by secretary via ManageGuards).
  const guard = await prisma.user.findFirst({
    where: {
      role: 'GUARD',
      guardPin: pin,
      isActive: true,
      wing: { name: { equals: wing_code, mode: 'insensitive' } },
    },
  });
  if (!guard) return unauthorized(res, 'Invalid wing code or PIN');

  const token = signToken({
    user_id: guard.id,
    role: guard.role,
    society_id: guard.societyId ?? '',
    wing_id: guard.wingId ?? '',
    flat_id: null,
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

  return ok(res, null, 'Logged out successfully');
}

import { randomUUID } from 'crypto';
import { prisma } from '../config/db';
import { invalidateAuthCache } from '../middleware/auth.middleware';
import { signToken } from '../utils/jwt';

interface LoginUser {
  id: string;
  name: string;
  phone: string;
  role: string;
  societyId: string | null;
  wingId: string | null;
  flatId: string | null;
  isPrimary: boolean;
}

/**
 * Starts a fresh login for a person whose identity has just been proven
 * (correct PIN, or correct activation code + new PIN) and returns the same
 * payload shape the app and Command Centre already expect.
 *
 * One device at a time: every login rotates the user's session id, so the
 * previous phone is signed out. Admins signing in on the Command Centre
 * website (it sends a device_id) get a separate 'web' session so using the
 * website never signs the Secretary out of the mobile app, or the other way round.
 */
export async function completeLogin(user: LoginUser, opts: { deviceId?: string } = {}) {
  let societyName: string | null = null;
  if (user.societyId) {
    const society = await prisma.society.findUnique({ where: { id: user.societyId }, select: { name: true } });
    societyName = society?.name ?? null;
  }

  const isWebAdminLogin =
    !!opts.deviceId && (user.role === 'SUPER_ADMIN' || user.role === 'WING_ADMIN');

  let sessionId = 'web';
  if (!isWebAdminLogin) {
    sessionId = randomUUID();
    await prisma.user.update({ where: { id: user.id }, data: { sessionId } });
    invalidateAuthCache(user.id);
  }

  const token = signToken({
    user_id: user.id,
    role: user.role,
    society_id: user.societyId ?? '',
    wing_id: user.wingId ?? '',
    flat_id: user.flatId ?? null,
    is_primary: user.isPrimary,
    name: user.name,
    society_name: societyName ?? undefined,
    sid: sessionId,
  });

  return {
    token,
    user: {
      id: user.id,
      name: user.name,
      phone: user.phone,
      role: user.role,
      societyId: user.societyId,
      societyName,
      wingId: user.wingId,
      flatId: user.flatId,
      isPrimary: user.isPrimary,
    },
  };
}

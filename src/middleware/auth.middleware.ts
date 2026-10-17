import { Request, Response, NextFunction } from 'express';
import { verifyToken, JwtPayload } from '../utils/jwt';
import { unauthorized } from '../utils/response';
import { prisma } from '../config/db';

declare global {
  namespace Express {
    interface Request {
      user: JwtPayload;
    }
  }
}

// Caches recent account lookups briefly so we're not hitting the DB on every
// single request, while still closing access within seconds of a person being
// deactivated or logging in on another device (access tokens live 30 days, so
// without this a removed family member would keep working until expiry).
type CacheEntry = { active: boolean; sessionId: string | null; validAfter: number; checkedAt: number };
const authCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;

export function invalidateAuthCache(userId: string) {
  authCache.delete(userId);
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return unauthorized(res, 'No token provided');
  }

  const token = authHeader.split(' ')[1];
  let payload: JwtPayload;
  try {
    payload = verifyToken(token);
  } catch {
    return unauthorized(res, 'Invalid or expired token');
  }

  try {
    let entry = authCache.get(payload.user_id);
    if (!entry || Date.now() - entry.checkedAt >= CACHE_TTL_MS) {
      const user = await prisma.user.findUnique({
        where: { id: payload.user_id },
        select: { isActive: true, sessionId: true, sessionsValidAfter: true },
      });
      entry = {
        active: !!user?.isActive,
        sessionId: user?.sessionId ?? null,
        validAfter: user?.sessionsValidAfter ? Math.floor(user.sessionsValidAfter.getTime() / 1000) : 0,
        checkedAt: Date.now(),
      };
      authCache.set(payload.user_id, entry);
    }
    if (!entry.active) {
      return unauthorized(res, 'Your access has been revoked. Please contact your Wing Secretary.');
    }
    // Accounts that have logged in since one-device login was introduced carry
    // a session id; a token with a different (or missing) id belongs to an
    // older login on another device. Accounts with no session id yet are
    // accepted so nobody is signed out by the rollout itself.
    // 'web' tokens are Command Centre admin sessions, which are not limited to one device.
    if (entry.sessionId && payload.sid !== 'web' && payload.sid !== entry.sessionId) {
      return unauthorized(res, 'You were signed out because this account was logged in on another device.');
    }
    // A PIN reset or change signs out everything issued before it — including
    // Command Centre ('web') sessions, which the check above does not cover.
    if (entry.validAfter && (payload.iat ?? 0) < entry.validAfter) {
      return unauthorized(res, 'Your PIN was changed. Please sign in again.');
    }
  } catch (err) {
    // If the DB check itself fails (transient outage), don't lock everyone
    // out — fall back to trusting the token rather than cascading an
    // unrelated failure into every authenticated request.
    console.error('[authenticate] account check failed:', err);
  }

  req.user = payload;
  next();
}

import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/db';
import { forbidden } from '../utils/response';

/** A guard who covers every tower of the society has no wing of their own. */
export const isSocietyGuard = (req: Request) => req.user?.role === 'GUARD' && !req.user?.wing_id && !!req.user?.society_id;

export function wingGuard(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.wing_id && !isSocietyGuard(req)) {
    return forbidden(res, 'Wing context missing');
  }
  next();
}

export const getWingFilter = (req: Request) => ({ wingId: req.user.wing_id });

/**
 * The wings this request may see: the person's own wing, or, for a society-wide
 * guard, every wing of their society. Use as `wingId: { in: await scopeWingIds(req) }`.
 */
export async function scopeWingIds(req: Request): Promise<string[]> {
  if (!isSocietyGuard(req)) return req.user.wing_id ? [req.user.wing_id] : [];
  const wings = await prisma.wing.findMany({ where: { societyId: req.user.society_id }, select: { id: true } });
  return wings.map((w) => w.id);
}

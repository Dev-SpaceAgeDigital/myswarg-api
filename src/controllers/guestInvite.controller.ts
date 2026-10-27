import { Request, Response } from 'express';
import { z } from 'zod';
import { randomInt } from 'crypto';
import { notifyFlat } from '../services/notification.service';
import { prisma } from '../config/db';
import { scopeWingIds } from '../middleware/wingGuard';
import { ok, created, badRequest, notFound, forbidden } from '../utils/response';

const createSchema = z.object({
  guest_name: z.string().min(1, 'Guest name is required'),
  guest_phone: z.string().regex(/^[6-9]\d{9}$/).optional(),
  purpose: z.string().optional(),
  visit_date: z.string().datetime().optional(),
  // A pass can be used every day (maid, driver, milk delivery) until it expires.
  is_pass: z.boolean().optional(),
  valid_days: z.number().int().min(1).max(365).optional(),
});

/** A 6-digit code no other open invite or pass of the same society is using. */
async function uniqueInviteCode(societyWingIds: string[]): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = String(randomInt(100000, 1000000));
    const clash = await prisma.guestInvite.findFirst({ where: { wingId: { in: societyWingIds }, otpCode: code, status: 'PENDING' } });
    if (!clash) return code;
  }
  throw new Error('Could not generate a unique code');
}

const DAY = 24 * 60 * 60 * 1000;

export async function listMyInvites(req: Request, res: Response) {
  const invites = await prisma.guestInvite.findMany({
    where: { createdById: req.user.user_id },
    orderBy: { createdAt: 'desc' },
  });
  return ok(res, invites);
}

export async function createInvite(req: Request, res: Response) {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.errors[0].message);

  const flatId = req.user.flat_id;
  const wingId = req.user.wing_id;
  if (!flatId || !wingId) return badRequest(res, 'No flat associated with your account');

  const isPass = !!parsed.data.is_pass;
  if (!isPass && !parsed.data.visit_date) return badRequest(res, 'Please choose the visit date');
  const validDays = parsed.data.valid_days ?? 30;

  const wing = await prisma.wing.findUnique({ where: { id: wingId }, select: { societyId: true } });
  const societyWings = wing
    ? (await prisma.wing.findMany({ where: { societyId: wing.societyId }, select: { id: true } })).map((w) => w.id)
    : [wingId];

  const invite = await prisma.guestInvite.create({
    data: {
      wingId,
      flatId,
      createdById: req.user.user_id,
      guestName: parsed.data.guest_name,
      guestPhone: parsed.data.guest_phone,
      purpose: parsed.data.purpose,
      visitDate: isPass ? new Date() : new Date(parsed.data.visit_date!),
      otpCode: await uniqueInviteCode(societyWings),
      isPass,
      validUntil: isPass ? new Date(Date.now() + validDays * DAY) : null,
    } as any,
  });
  return created(res, invite, isPass
    ? `Pass created for ${validDays} days. Share the code with ${parsed.data.guest_name}.`
    : 'Guest invite created — share the code with your guest');
}

export async function cancelInvite(req: Request, res: Response) {
  const { id } = req.params;
  const invite = await prisma.guestInvite.findUnique({ where: { id } });
  if (!invite) return notFound(res, 'Invite not found');
  if (invite.createdById !== req.user.user_id) return forbidden(res, 'Not your invite');
  if (invite.status !== 'PENDING') return badRequest(res, 'Only pending invites can be cancelled');

  const updated = await prisma.guestInvite.update({ where: { id }, data: { status: 'CANCELLED' } });
  return ok(res, updated, 'Invite cancelled');
}

const verifySchema = z.object({
  otp_code: z.string().min(4),
});

// Guard-facing: verifies the code shared by the guest and, on success,
// auto-creates the visitor entry log so the guard doesn't re-type details.
export async function verifyInviteCode(req: Request, res: Response) {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.errors[0].message);

  const invite = await prisma.guestInvite.findFirst({
    where: { wingId: { in: await scopeWingIds(req) }, otpCode: parsed.data.otp_code, status: 'PENDING' },
    include: { flat: { select: { number: true, floor: true } } },
  });
  if (!invite) return notFound(res, 'No matching invite or pass found for this code');

  const now = Date.now();
  const inv: any = invite;
  if (inv.isPass && inv.validUntil && new Date(inv.validUntil).getTime() < now) {
    await prisma.guestInvite.update({ where: { id: invite.id }, data: { status: 'EXPIRED' } });
    return badRequest(res, `This pass expired on ${new Date(inv.validUntil).toLocaleDateString('en-IN')}. Ask the resident to renew it.`);
  }
  if (!inv.isPass && new Date(invite.visitDate).getTime() < now - 2 * DAY) {
    await prisma.guestInvite.update({ where: { id: invite.id }, data: { status: 'EXPIRED' } });
    return badRequest(res, 'This guest invite has expired. Ask the resident for a new one.');
  }

  const visitor = await prisma.visitor.create({
    data: {
      wingId: invite.wingId,
      flatId: invite.flatId,
      visitorName: invite.guestName,
      purpose: invite.purpose,
      status: 'APPROVED',
      entryTime: new Date(),
      approvalMethod: inv.isPass ? 'PASS' : 'GUEST_CODE',
    } as any,
  });

  // A one-time invite is used up; a pass stays valid and just counts the visit.
  const updated = await prisma.guestInvite.update({
    where: { id: invite.id },
    data: inv.isPass
      ? ({ usedAt: new Date(), useCount: { increment: 1 }, createdVisitorId: visitor.id } as any)
      : ({ status: 'USED', usedAt: new Date(), createdVisitorId: visitor.id } as any),
    include: { flat: { select: { number: true, floor: true } } },
  });

  notifyFlat({
    flatId: invite.flatId,
    title: inv.isPass ? `${invite.guestName} has arrived` : 'Your guest has arrived',
    body: inv.isPass
      ? `${invite.guestName}${invite.purpose ? ` (${invite.purpose})` : ''} was let in with their pass.`
      : `${invite.guestName} was let in using the guest code.`,
    type: 'VISITOR_APPROVED',
    relatedId: visitor.id,
  });

  return ok(res, updated, `Entry approved for ${invite.guestName} (Flat ${invite.flat.number})`);
}

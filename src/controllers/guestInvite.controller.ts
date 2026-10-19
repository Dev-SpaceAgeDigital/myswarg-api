import { Request, Response } from 'express';
import { z } from 'zod';
import { notifyFlat } from '../services/notification.service';
import { prisma } from '../config/db';
import { ok, created, badRequest, notFound, forbidden } from '../utils/response';

const createSchema = z.object({
  guest_name: z.string().min(1, 'Guest name is required'),
  guest_phone: z.string().regex(/^[6-9]\d{9}$/).optional(),
  purpose: z.string().optional(),
  visit_date: z.string().datetime(),
});

function generateOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

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

  const invite = await prisma.guestInvite.create({
    data: {
      wingId,
      flatId,
      createdById: req.user.user_id,
      guestName: parsed.data.guest_name,
      guestPhone: parsed.data.guest_phone,
      purpose: parsed.data.purpose,
      visitDate: new Date(parsed.data.visit_date),
      otpCode: generateOtp(),
    } as any,
  });
  return created(res, invite, 'Guest invite created — share the code with your guest');
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
    where: { wingId: req.user.wing_id, otpCode: parsed.data.otp_code, status: 'PENDING' },
    include: { flat: { select: { number: true, floor: true } } },
  });
  if (!invite) return notFound(res, 'No matching pending invite found for this code');

  const visitor = await prisma.visitor.create({
    data: {
      wingId: invite.wingId,
      flatId: invite.flatId,
      visitorName: invite.guestName,
      purpose: invite.purpose,
      status: 'APPROVED',
      entryTime: new Date(),
    },
  });

  const updated = await prisma.guestInvite.update({
    where: { id: invite.id },
    data: { status: 'USED', usedAt: new Date(), createdVisitorId: visitor.id } as any,
    include: { flat: { select: { number: true, floor: true } } },
  });

  notifyFlat({
    flatId: invite.flatId,
    title: 'Your guest has arrived',
    body: `${invite.guestName} was let in using the guest code.`,
    type: 'VISITOR_APPROVED',
    relatedId: visitor.id,
  });

  return ok(res, updated, `Entry approved for ${invite.guestName} (Flat ${invite.flat.number})`);
}

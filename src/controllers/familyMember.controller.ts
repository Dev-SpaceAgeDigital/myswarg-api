import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { ok, created, badRequest, notFound, forbidden } from '../utils/response';
import { notifyWingAdmins, residentLabel } from '../services/notification.service';
import { issueActivationCode, formatActivationCode, pinSummaryOf } from '../services/pin.service';

const RELATIONS = ['SPOUSE', 'CHILD', 'PARENT', 'SIBLING', 'OTHER'] as const;

const addSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  phone: z.string().regex(/^[6-9]\d{9}$/, 'Invalid mobile number'),
  relation: z.enum(RELATIONS),
});

// Any resident of the flat can view the family list; only the head-of-family
// (isPrimary) can add or remove members. Login itself needs no changes —
// each member has their own phone number and signs in with their own PIN.
// The head of family hands over the one-time activation code (and can reset
// a family member's forgotten PIN), the same way the Secretary does for residents.
export async function listFamilyMembers(req: Request, res: Response) {
  const flatId = req.user.flat_id;
  if (!flatId) return badRequest(res, 'No flat associated with your account');

  const members = await prisma.user.findMany({
    where: { flatId, role: 'RESIDENT', isActive: true },
    select: {
      id: true, name: true, phone: true, isPrimary: true, familyRelation: true, createdAt: true,
      pinSetAt: true, activationCodeHash: true, activationExpiresAt: true,
    },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  });
  return ok(res, members.map(({ pinSetAt, activationCodeHash, activationExpiresAt, ...m }) => ({
    ...m,
    pin: pinSummaryOf({ pinSetAt, activationCodeHash, activationExpiresAt }),
  })));
}

export async function addFamilyMember(req: Request, res: Response) {
  const parsed = addSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.errors[0].message);

  const requester = await prisma.user.findUnique({ where: { id: req.user.user_id } });
  if (!requester?.isPrimary) return forbidden(res, 'Only the head of family can add family members');

  const flatId = req.user.flat_id;
  const wingId = req.user.wing_id;
  if (!flatId || !wingId) return badRequest(res, 'No flat associated with your account');

  const existing = await prisma.user.findUnique({ where: { phone: parsed.data.phone } });
  if (existing) return badRequest(res, 'This phone number is already registered to another account');

  const member = await prisma.user.create({
    data: {
      name: parsed.data.name,
      phone: parsed.data.phone,
      familyRelation: parsed.data.relation,
      role: 'RESIDENT',
      isPrimary: false,
      societyId: requester.societyId,
      wingId,
      flatId,
    } as any,
  });
  residentLabel(req.user.user_id).then((who) =>
    notifyWingAdmins({
      wingId,
      title: 'Family member added',
      body: `${who} added ${parsed.data.name} (${parsed.data.relation}).`,
      type: 'FAMILY_ADDED',
      relatedId: member.id,
    }),
  );
  const issued = await issueActivationCode(member.id);
  return created(
    res,
    { id: member.id, name: member.name, phone: member.phone, activation: { code: formatActivationCode(issued.code), expiresAt: issued.expiresAt } },
    'Family member added. Share the activation code with them.',
  );
}

export async function removeFamilyMember(req: Request, res: Response) {
  const { id } = req.params;

  const requester = await prisma.user.findUnique({ where: { id: req.user.user_id } });
  if (!requester?.isPrimary) return forbidden(res, 'Only the head of family can remove family members');

  const member = await prisma.user.findFirst({ where: { id, flatId: req.user.flat_id ?? undefined, role: 'RESIDENT' } });
  if (!member) return notFound(res, 'Family member not found');
  if (member.isPrimary) return badRequest(res, 'Cannot remove the head of family');

  await prisma.user.update({ where: { id }, data: { isActive: false } });
  residentLabel(req.user.user_id).then((who) =>
    notifyWingAdmins({
      wingId: req.user.wing_id,
      title: 'Family member removed',
      body: `${who} removed ${member.name}.`,
      type: 'FAMILY_REMOVED',
      relatedId: member.id,
    }),
  );
  return ok(res, null, 'Family member removed');
}

// Head of family: a family member forgot their PIN. Issues a fresh one-time code.
export async function resetFamilyMemberPin(req: Request, res: Response) {
  const requester = await prisma.user.findUnique({ where: { id: req.user.user_id } });
  if (!requester?.isPrimary) return forbidden(res, 'Only the head of family can reset a family member\'s PIN');

  const member = await prisma.user.findFirst({
    where: { id: req.params.id, flatId: req.user.flat_id ?? undefined, role: 'RESIDENT', isActive: true },
  });
  if (!member) return notFound(res, 'Family member not found');
  if (member.isPrimary) return badRequest(res, 'Use the Change PIN option for your own account');

  const issued = await issueActivationCode(member.id, { resetPin: true });
  return ok(
    res,
    { id: member.id, name: member.name, phone: member.phone, activation: { code: formatActivationCode(issued.code), expiresAt: issued.expiresAt } },
    'PIN reset. Share the new code.',
  );
}

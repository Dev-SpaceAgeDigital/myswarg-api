import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { ok, created, badRequest, notFound } from '../utils/response';
import { codeIfNeeded, issueActivationCode, phoneConflict, pinSummaryOf, IssuedCode, hashSecret, compareSecret, weakPinReason } from '../services/pin.service';
import { ensureSocietyCode } from '../services/societyCode.service';
import { scopeWingIds, isSocietyGuard } from '../middleware/wingGuard';

// What the app shows once, right after a code is issued.
function activationPayload(c: IssuedCode | null) {
  return c ? { code: c.formatted, expiresAt: c.expiresAt } : null;
}

// Adds a safe sign-in status to a person and drops the hashes before sending.
function withPinSummary<T extends { pinSetAt?: Date | null; activationCodeHash?: string | null; activationExpiresAt?: Date | null }>(u: T) {
  const { pinSetAt, activationCodeHash, activationExpiresAt, ...rest } = u as any;
  return { ...rest, pin: pinSummaryOf({ pinSetAt: pinSetAt ?? null, activationCodeHash: activationCodeHash ?? null, activationExpiresAt: activationExpiresAt ?? null }) };
}

const createFlatSchema = z.object({
  number: z.string().min(1),
  floor: z.number().int().min(0),
});

const updateFlatSchema = z.object({
  number: z.string().min(1).optional(),
  floor: z.number().int().min(0).optional(),
  familyMembers: z.number().int().min(1).max(20).optional(),
});

const addResidentSchema = z.object({
  flatId: z.string().min(1, 'Flat is required'),
  primaryResident: z.object({
    name: z.string().min(1, 'Primary resident name is required'),
    phone: z.string().regex(/^[6-9]\d{9}$/, 'Invalid primary mobile number'),
  }),
  secondResident: z.object({
    name: z.string().min(1, 'Second resident name is required'),
    phone: z.string().regex(/^[6-9]\d{9}$/, 'Invalid second mobile number'),
  }).nullable().optional(),
  familyMembers: z.number().int().min(1).max(8).default(1),
  vehicles: z.array(z.object({
    type: z.enum(['BIKE', 'CAR', 'AUTO', 'OTHER']),
    plateNumber: z.string().min(1),
  })).optional().default([]),
});

const addGuardSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  phone: z.string().regex(/^[6-9]\d{9}$/, 'Invalid mobile number'),
  pin: z.string().regex(/^\d{6}$/, 'Guard PIN must be 6 digits'),
});

export async function listFlats(req: Request, res: Response) {
  try {
    const wingId = req.user.wing_id;
    console.log('[listFlats] User wing_id:', wingId, 'role:', req.user.role);

    if (!wingId && !isSocietyGuard(req)) {
      return res.status(400).json({
        success: false,
        message: 'Wing not assigned. Contact Super Admin.',
      });
    }

    const vacantOnly = req.query.vacant === 'true';

    const flats = await prisma.flat.findMany({
      where: {
        wingId: { in: await scopeWingIds(req) },
        ...(vacantOnly ? { users: { none: { isActive: true } } } : {}),
      },
      include: {
        wing: { select: { id: true, name: true } },
        vehicles: { select: { id: true, type: true, plateNumber: true } },
        users: {
          where: { isActive: true },
          select: {
            id: true, name: true, phone: true, role: true,
            residentType: true, leaseStart: true, leaseEnd: true,
            pinSetAt: true, activationCodeHash: true, activationExpiresAt: true,
          },
        },
      },
      orderBy: [{ floor: 'asc' }, { number: 'asc' }],
    });

    return ok(res, flats.map((f) => ({ ...f, users: f.users.map(withPinSummary) })));
  } catch (err: any) {
    console.error('[listFlats] Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function getFlatDetail(req: Request, res: Response) {
  const flat = await prisma.flat.findFirst({
    where: { id: req.params.id, wingId: req.user.wing_id },
    select: { id: true, number: true, floor: true, familyMembers: true },
  });
  if (!flat) return notFound(res, 'Flat not found');

  const [residents, vehicles, recentBills] = await Promise.all([
    prisma.user.findMany({
      where: { flatId: flat.id, isActive: true },
      select: {
        id: true, name: true, phone: true, role: true, residentType: true,
        pinSetAt: true, activationCodeHash: true, activationExpiresAt: true,
      },
    }),
    prisma.vehicle.findMany({
      where: { flatId: flat.id },
      select: { id: true, type: true, plateNumber: true },
    }),
    prisma.maintenanceBill.findMany({
      where: { flatId: flat.id },
      select: { id: true, month: true, year: true, amount: true, status: true },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      take: 3,
    }),
  ]);

  return ok(res, { flat, residents: residents.map(withPinSummary), vehicles, recentBills });
}

export async function createFlat(req: Request, res: Response) {
  const parsed = createFlatSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.errors[0].message);

  const flat = await prisma.flat.create({
    data: { ...parsed.data, wingId: req.user.wing_id } as any,
  });
  return created(res, flat, 'Flat created');
}

export async function updateFlat(req: Request, res: Response) {
  const parsed = updateFlatSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.errors[0].message);

  const flat = await prisma.flat.findFirst({ where: { id: req.params.id, wingId: req.user.wing_id } });
  if (!flat) return notFound(res, 'Flat not found');

  const updated = await prisma.flat.update({ where: { id: req.params.id }, data: parsed.data });
  return ok(res, updated);
}

export async function addResident(req: Request, res: Response) {
  const parsed = addResidentSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.errors[0].message);

  const { flatId, primaryResident, secondResident, familyMembers, vehicles } = parsed.data;

  const flat = await prisma.flat.findFirst({ where: { id: flatId, wingId: req.user.wing_id } });
  if (!flat) return notFound(res, 'Flat not found');

  const wing = await prisma.wing.findUnique({ where: { id: req.user.wing_id } });
  if (!wing) return notFound(res, 'Wing not found');

  const currentCount = await prisma.user.count({ where: { flatId, role: 'RESIDENT', isActive: true } });
  const adding = secondResident ? 2 : 1;
  if (currentCount + adding > 2) {
    return badRequest(res, `This flat already has ${currentCount} resident(s). Maximum 2 logins allowed per flat.`);
  }

  // Check every number before creating anyone, so a conflict never leaves half the flat added.
  const people = [primaryResident, ...(secondResident ? [secondResident] : [])];
  const before = new Map<string, any>();
  for (const person of people) {
    const existing = await prisma.user.findUnique({ where: { phone: person.phone } });
    const conflict = phoneConflict(existing, { role: 'RESIDENT', wingId: req.user.wing_id });
    if (conflict) return badRequest(res, `${person.phone}: ${conflict}`);
    before.set(person.phone, existing);
  }

  const primary = await prisma.user.upsert({
    where: { phone: primaryResident.phone },
    create: {
      name: primaryResident.name,
      phone: primaryResident.phone,
      role: 'RESIDENT',
      residentType: 'OWNER',
      familyMembers,
      isPrimary: true,
      societyId: wing.societyId,
      wingId: req.user.wing_id,
      flatId,
      isActive: true,
    },
    update: {
      name: primaryResident.name,
      residentType: 'OWNER',
      familyMembers,
      isPrimary: true,
      wingId: req.user.wing_id,
      flatId,
      isActive: true,
    },
  });

  let second: { id: string; name: string; phone: string } | null = null;
  if (secondResident) {
    second = await prisma.user.upsert({
      where: { phone: secondResident.phone },
      create: {
        name: secondResident.name,
        phone: secondResident.phone,
        role: 'RESIDENT',
        residentType: 'OWNER',
        familyMembers,
        isPrimary: false,
        societyId: wing.societyId,
        wingId: req.user.wing_id,
        flatId,
        isActive: true,
      },
      update: {
        name: secondResident.name,
        residentType: 'OWNER',
        familyMembers,
        isPrimary: false,
        wingId: req.user.wing_id,
        flatId,
        isActive: true,
      },
    });
  }

  await prisma.flat.update({ where: { id: flatId }, data: { familyMembers } });

  if (vehicles && vehicles.length > 0) {
    await prisma.vehicle.deleteMany({ where: { flatId } });
    await prisma.vehicle.createMany({
      data: vehicles.map((v) => ({
        flatId,
        wingId: req.user.wing_id,
        type: v.type,
        plateNumber: v.plateNumber,
      })),
    });
  }

  // One-time activation codes: shown once to the Secretary, who hands them over.
  const activations = [];
  for (const person of [primary, ...(second ? [second] : [])]) {
    const issued = await codeIfNeeded(person.id, before.get(person.phone) ?? null);
    activations.push({ id: person.id, name: person.name, phone: person.phone, activation: activationPayload(issued) });
  }

  return created(res, { id: primary.id, name: primary.name, activations }, 'Resident added');
}

export async function removeResident(req: Request, res: Response) {
  const user = await prisma.user.findFirst({ where: { id: req.params.id, wingId: req.user.wing_id } });
  if (!user) return notFound(res, 'Resident not found');

  await prisma.user.update({ where: { id: req.params.id }, data: { isActive: false, flatId: null } });
  return ok(res, null, 'Resident removed');
}

// Guards sign in with the society code and their own PIN, so no two guards of
// the same society may share a PIN: the PIN is what tells them apart.
async function pinUsedByAnotherGuard(societyId: string, pin: string, exceptId?: string): Promise<boolean> {
  const others = await prisma.user.findMany({
    where: {
      role: 'GUARD', isActive: true,
      OR: [{ societyId }, { wing: { societyId } }],
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { guardPin: true, guardPinHash: true },
  });
  for (const g of others) {
    if (g.guardPinHash && (await compareSecret(pin, g.guardPinHash))) return true;
    if (!g.guardPinHash && g.guardPin === pin) return true;
  }
  return false;
}

// Guards this Secretary manages: their own wing's guards plus the guards who
// cover every tower of the society.
function guardsWhere(wingId: string, societyId: string) {
  return { role: 'GUARD' as const, isActive: true, OR: [{ wingId }, { wingId: null, societyId }] };
}

export async function getGuards(req: Request, res: Response) {
  const wing = await prisma.wing.findUnique({
    where: { id: req.user.wing_id },
    select: { name: true, societyId: true, society: { select: { _count: { select: { wings: true } } } } },
  });
  if (!wing) return notFound(res, 'Wing not found');
  const guards = await prisma.user.findMany({
    where: guardsWhere(req.user.wing_id, wing.societyId),
    select: { id: true, name: true, phone: true, wingId: true, guardPinHash: true, guardPin: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const societyCode = await ensureSocietyCode(wing.societyId);
  return ok(res, {
    // PINs are never sent back, only whether one is set.
    guards: guards.map(({ guardPinHash, guardPin, wingId, ...g }) => ({
      ...g, hasPin: !!(guardPinHash || guardPin), allTowers: !wingId,
    })),
    wingName: wing.name,
    societyCode,
    towerCount: wing.society._count.wings,
  });
}

export async function addGuard(req: Request, res: Response) {
  const parsed = addGuardSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.errors[0].message);

  const { name, phone, pin } = parsed.data;
  const allTowers = req.body?.all_towers !== false; // default: the guard covers every tower
  const weak = weakPinReason(pin);
  if (weak) return badRequest(res, weak);

  const wing = await prisma.wing.findUnique({ where: { id: req.user.wing_id } });
  if (!wing) return notFound(res, 'Wing not found');

  // Prevent a non-guard phone number from being overwritten
  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing && existing.role !== 'GUARD') {
    return badRequest(res, `Phone ${phone} is already registered to another user`);
  }
  if (existing && existing.isActive && existing.societyId && existing.societyId !== wing.societyId) {
    return badRequest(res, 'This guard is already registered with another society.');
  }
  if (await pinUsedByAnotherGuard(wing.societyId, pin, existing?.id)) {
    return badRequest(res, 'Another guard of this society already uses this PIN. Please choose a different one.');
  }

  const guardPinHash = await hashSecret(pin);
  const wingId = allTowers ? null : req.user.wing_id;
  const guard = await prisma.user.upsert({
    where: { phone },
    create: { name, phone, role: 'GUARD', guardPinHash, societyId: wing.societyId, wingId },
    update: { name, role: 'GUARD', guardPinHash, guardPin: null, societyId: wing.societyId, wingId, isActive: true },
  });

  return created(res, { id: guard.id, name: guard.name }, 'Guard added');
}

export async function updateGuardPin(req: Request, res: Response) {
  const { guardId } = req.params;
  const pin = String(req.body?.pin ?? '');

  if (!/^\d{6}$/.test(pin)) return badRequest(res, 'Guard PIN must be 6 digits');
  const weak = weakPinReason(pin);
  if (weak) return badRequest(res, weak);

  const wing = await prisma.wing.findUnique({ where: { id: req.user.wing_id }, select: { societyId: true } });
  if (!wing) return notFound(res, 'Wing not found');
  const guard = await prisma.user.findFirst({ where: { id: guardId, ...guardsWhere(req.user.wing_id, wing.societyId) } });
  if (!guard) return notFound(res, 'Guard not found');
  if (await pinUsedByAnotherGuard(wing.societyId, pin, guardId)) {
    return badRequest(res, 'Another guard of this society already uses this PIN. Please choose a different one.');
  }

  await prisma.user.update({ where: { id: guardId }, data: { guardPinHash: await hashSecret(pin), guardPin: null } });
  return ok(res, null, 'PIN updated successfully');
}

const updateResidentSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  phone: z.string().regex(/^[6-9]\d{9}$/, 'Invalid mobile number'),
  familyMembers: z.number().int().min(1).max(8),
});

export async function updateResident(req: Request, res: Response) {
  const parsed = updateResidentSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.errors[0].message);

  const { name, phone, familyMembers } = parsed.data;
  const { userId } = req.params;

  const user = await prisma.user.findFirst({
    where: { id: userId, wingId: req.user.wing_id, isActive: true },
  });
  if (!user) return notFound(res, 'Resident not found');

  const phoneChanged = phone !== user.phone;
  if (phoneChanged) {
    const taken = await prisma.user.findUnique({ where: { phone } });
    if (taken) return badRequest(res, 'This phone number is already registered to another account.');
  }

  await prisma.user.update({ where: { id: userId }, data: { name, phone } });

  if (user.flatId) {
    await prisma.flat.update({ where: { id: user.flatId }, data: { familyMembers } });
  }

  // A new phone number means a different person may now use this account, so the
  // old PIN and every old login are wiped and a fresh activation code is issued.
  const activation = phoneChanged
    ? activationPayload(await issueActivationCode(userId, { resetPin: true }))
    : null;

  return ok(res, { activation }, phoneChanged ? 'Resident updated. Share the new activation code.' : 'Resident updated');
}

const addVehicleSchema = z.object({
  flatId: z.string().min(1),
  type: z.enum(['BIKE', 'CAR', 'AUTO', 'OTHER']),
  plateNumber: z.string().min(1, 'Plate number is required'),
});

export async function addVehicle(req: Request, res: Response) {
  const parsed = addVehicleSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.errors[0].message);

  const { flatId, type, plateNumber } = parsed.data;

  const flat = await prisma.flat.findFirst({ where: { id: flatId, wingId: req.user.wing_id } });
  if (!flat) return notFound(res, 'Flat not found');

  const vehicle = await prisma.vehicle.create({
    data: { flatId, wingId: req.user.wing_id, type, plateNumber },
  });
  return created(res, vehicle, 'Vehicle added');
}

export async function deleteVehicle(req: Request, res: Response) {
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: req.params.id, wingId: req.user.wing_id },
  });
  if (!vehicle) return notFound(res, 'Vehicle not found');

  await prisma.vehicle.delete({ where: { id: req.params.id } });
  return ok(res, null, 'Vehicle removed');
}

const addStaffSchema = z.object({
  name: z.string().min(1),
  phone: z.string().regex(/^[6-9]\d{9}$/),
});

export async function addStaff(req: Request, res: Response) {
  const parsed = addStaffSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.errors[0].message);

  const { name, phone } = parsed.data;
  const wing = await prisma.wing.findUnique({ where: { id: req.user.wing_id } });
  if (!wing) return notFound(res, 'Wing not found');

  const existing = await prisma.user.findUnique({ where: { phone } });
  const conflict = phoneConflict(existing, { role: 'RESIDENT', wingId: req.user.wing_id });
  if (conflict) return badRequest(res, conflict);

  const staff = await prisma.user.upsert({
    where: { phone },
    create: { name, phone, role: 'RESIDENT', societyId: wing.societyId, wingId: req.user.wing_id },
    update: { name, isActive: true },
  });
  const activation = activationPayload(await codeIfNeeded(staff.id, existing));

  return created(res, { id: staff.id, name: staff.name, phone: staff.phone, activation }, 'Staff added');
}

export async function getSecretaryProfile(req: Request, res: Response) {
  const user = await prisma.user.findUnique({
    where: { id: req.user.user_id },
    select: { name: true, phone: true, upiId: true },
  });
  if (!user) return notFound(res, 'User not found');
  return ok(res, user);
}

export async function updateSecretaryUpi(req: Request, res: Response) {
  const { upiId } = req.body;
  if (!upiId || typeof upiId !== 'string' || !upiId.includes('@')) {
    return badRequest(res, 'Invalid UPI ID. Must contain @ symbol.');
  }
  await prisma.user.update({
    where: { id: req.user.user_id },
    data: { upiId: upiId.trim() },
  });
  return ok(res, null, 'UPI ID saved successfully');
}

// A forgotten PIN: wipes the old one, signs the person out everywhere, and issues
// a new one-time activation code that the Secretary hands over.
export async function resetResidentPin(req: Request, res: Response) {
  const user = await prisma.user.findFirst({
    where: { id: req.params.userId, wingId: req.user.wing_id, isActive: true, role: 'RESIDENT' },
  });
  if (!user) return notFound(res, 'Resident not found');

  const issued = await issueActivationCode(user.id, { resetPin: true });
  return ok(res, { name: user.name, phone: user.phone, activation: activationPayload(issued) }, 'PIN reset. Share the new code.');
}

// ─── Co-secretaries ──────────────────────────────────────────────────────────
// A wing can have two Secretaries. Each can reset the other's PIN, so a
// forgotten PIN doesn't need the platform team.
export async function listSecretaries(req: Request, res: Response) {
  const people = await prisma.user.findMany({
    where: { wingId: req.user.wing_id, role: 'WING_ADMIN', isActive: true },
    select: { id: true, name: true, phone: true, isPrimary: true, pinSetAt: true, activationCodeHash: true, activationExpiresAt: true },
    orderBy: { createdAt: 'asc' },
  });
  return ok(res, people.map((p) => ({ ...withPinSummary(p), isMe: p.id === req.user.user_id })));
}

export async function resetSecretaryPin(req: Request, res: Response) {
  if (req.params.userId === req.user.user_id) {
    return badRequest(res, 'Use Change PIN for your own account. If you forgot it, ask your co-secretary or MySwarg support.');
  }
  const target = await prisma.user.findFirst({
    where: { id: req.params.userId, wingId: req.user.wing_id, role: 'WING_ADMIN', isActive: true },
  });
  if (!target) return notFound(res, 'Secretary not found');
  const issued = await issueActivationCode(target.id, { resetPin: true });
  return ok(res, { name: target.name, phone: target.phone, activation: activationPayload(issued) }, 'PIN reset. Share the new code.');
}

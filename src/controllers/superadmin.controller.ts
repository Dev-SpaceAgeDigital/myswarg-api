import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { ok, created, badRequest, notFound } from '../utils/response';
import { codeIfNeeded, issueActivationCode, phoneConflict, pinSummaryOf, IssuedCode } from '../services/pin.service';

// What the Command Centre shows once, right after a code is issued.
function activationPayload(c: IssuedCode | null) {
  return c ? { code: c.formatted, expiresAt: c.expiresAt } : null;
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export async function getStats(_req: Request, res: Response) {
  const [totalSocieties, totalWings] = await Promise.all([
    prisma.society.count(),
    prisma.wing.count(),
  ]);

  const allOccupiedFlats = await prisma.flat.findMany({
    where: { users: { some: { role: 'RESIDENT' } } },
    select: {
      familyMembers: true,
      users: { where: { role: 'RESIDENT' }, select: { id: true } },
    },
  });

  const totalResidents = allOccupiedFlats.reduce((sum, flat) => {
    const count = flat.familyMembers > 0 ? flat.familyMembers : flat.users.length;
    return sum + count;
  }, 0);

  return ok(res, { societies: totalSocieties, wings: totalWings, residents: totalResidents });
}

// ─── Societies ────────────────────────────────────────────────────────────────

export async function getSocieties(_req: Request, res: Response) {
  const societies = await prisma.society.findMany({
    include: {
      wings: {
        include: { _count: { select: { flats: true } } },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const result = await Promise.all(
    societies.map(async (s) => {
      const wings = await Promise.all(
        s.wings.map(async (w) => {
          const wingFlats = await prisma.flat.findMany({
            where: {
              wingId: w.id,
              users: { some: { role: 'RESIDENT' } },
            },
            select: {
              familyMembers: true,
              users: { where: { role: 'RESIDENT' }, select: { id: true } },
            },
          });
          const residentCount = wingFlats.reduce(
            (sum, f) => sum + (f.familyMembers > 0 ? f.familyMembers : f.users.length),
            0,
          );
          return { id: w.id, name: w.name, flatsCount: w._count.flats, residentCount, isActive: w.isActive, trialEndsAt: w.trialEndsAt };
        }),
      );
      return { ...s, wings };
    }),
  );

  return ok(res, result);
}

const createSocietySchema = z.object({
  name: z.string().min(2, 'Society name is required'),
  address: z.string().min(3, 'Address is required'),
  city: z.string().min(2, 'City is required'),
  state: z.string().min(2, 'State is required').default('Gujarat'),
  pinCode: z.string().regex(/^\d{6}$/, 'Pin code must be 6 digits').optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  mapAddress: z.string().optional(),
});

export async function createSociety(req: Request, res: Response) {
  const parsed = createSocietySchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.errors[0].message);
  const newSociety = await prisma.society.create({
    data: parsed.data as any,
  });

  const trialEnd = new Date();
  trialEnd.setDate(trialEnd.getDate() + 30);
  const society = await prisma.society.update({
    where: { id: newSociety.id },
    data: {
      subscriptionStart: new Date(),
      subscriptionEnd: trialEnd,
      trialEndsAt: trialEnd,
      subscriptionStatus: 'TRIAL',
      planType: 'STARTER',
      monthlyAmount: 499,
    },
  });

  return created(res, society);
}

const updateSocietySchema = z.object({
  name: z.string().min(2).optional(),
  address: z.string().min(3).optional(),
  city: z.string().min(2).optional(),
  state: z.string().min(2).optional(),
  pinCode: z.string().regex(/^\d{6}$/).optional().nullable(),
  notes: z.string().optional().nullable(),
});

export async function updateSociety(req: Request, res: Response) {
  const { id } = req.params;
  const parsed = updateSocietySchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.errors[0].message);
  const society = await prisma.society.findUnique({ where: { id } });
  if (!society) return notFound(res, 'Society not found');
  const updated = await prisma.society.update({ where: { id }, data: parsed.data });
  return ok(res, updated);
}

export async function deleteSociety(req: Request, res: Response) {
  const { id } = req.params;
  try {
    const wings = await prisma.wing.findMany({ where: { societyId: id }, select: { id: true } });
    const wingIds = wings.map((w) => w.id);

    if (wingIds.length > 0) {
      const flats = await prisma.flat.findMany({ where: { wingId: { in: wingIds } }, select: { id: true } });
      const flatIds = flats.map((f) => f.id);

      if (flatIds.length > 0) {
        await prisma.maintenanceBill.deleteMany({ where: { flatId: { in: flatIds } } });
        await prisma.vehicle.deleteMany({ where: { flatId: { in: flatIds } } });
      }

      await prisma.visitor.deleteMany({ where: { wingId: { in: wingIds } } });
      await prisma.complaint.deleteMany({ where: { wingId: { in: wingIds } } });

      const notices = await prisma.notice.findMany({ where: { wingId: { in: wingIds } }, select: { id: true } });
      if (notices.length > 0) {
        await prisma.noticeSeen.deleteMany({ where: { noticeId: { in: notices.map((n) => n.id) } } });
        await prisma.notice.deleteMany({ where: { wingId: { in: wingIds } } });
      }

      await prisma.session.deleteMany({
        where: { user: { wingId: { in: wingIds }, role: { notIn: ['SUPER_ADMIN', 'GUARD'] } } },
      });
      await prisma.user.deleteMany({
        where: { wingId: { in: wingIds }, role: { notIn: ['SUPER_ADMIN', 'GUARD'] } },
      });

      // Detach system users from this wing so wing deletion succeeds
      await prisma.user.updateMany({
        where: { wingId: { in: wingIds }, role: { in: ['SUPER_ADMIN', 'GUARD'] } },
        data: { wingId: null, societyId: null },
      });

      await prisma.flat.deleteMany({ where: { wingId: { in: wingIds } } });
      await prisma.wing.deleteMany({ where: { societyId: id } });
    }

    await prisma.society.delete({ where: { id } });

    // Re-attach system users to the next available society/wing
    const remainingSociety = await prisma.society.findFirst({ orderBy: { createdAt: 'asc' } });
    const remainingWing = remainingSociety
      ? await prisma.wing.findFirst({ where: { societyId: remainingSociety.id }, orderBy: { createdAt: 'asc' } })
      : null;

    if (remainingSociety && remainingWing) {
      await prisma.user.updateMany({
        where: { role: { in: ['SUPER_ADMIN', 'GUARD'] }, wingId: null },
        data: { societyId: remainingSociety.id, wingId: remainingWing.id },
      });
    }

    return ok(res, null, 'Society deleted successfully');
  } catch (error: any) {
    console.error('DELETE SOCIETY ERROR:', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
}

// ─── Wings ────────────────────────────────────────────────────────────────────

const createWingSchema = z.object({
  society_id: z.string().min(1, 'Society is required'),
  name: z.string().min(1, 'Wing name is required'),
  layout_type: z.enum(['FLOORS', 'UNITS']).default('FLOORS'),
  // FLOORS layout (apartment buildings)
  total_floors: z.number().int().min(1).optional(),
  flats_per_floor: z.number().int().min(1).optional(),
  // UNITS layout (villas / bungalows / row houses — no meaningful floors)
  total_units: z.number().int().min(1).optional(),
  unit_label: z.string().min(1).optional(),
  auto_generate_flats: z.boolean().default(false),
  secretary_name: z.string().min(2).optional(),
  secretary_phone: z.string().regex(/^[6-9]\d{9}$/).optional(),
});

export async function createWing(req: Request, res: Response) {
  const parsed = createWingSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.errors[0].message);

  const {
    society_id, name, layout_type,
    total_floors, flats_per_floor, total_units, unit_label,
    auto_generate_flats, secretary_name, secretary_phone,
  } = parsed.data;

  if (auto_generate_flats) {
    if (layout_type === 'FLOORS' && (!total_floors || !flats_per_floor)) {
      return badRequest(res, 'Total floors and flats per floor are required');
    }
    if (layout_type === 'UNITS' && !total_units) {
      return badRequest(res, 'Total number of units is required');
    }
  }

  const society = await prisma.society.findUnique({ where: { id: society_id } });
  if (!society) return notFound(res, 'Society not found');

  const wing = await prisma.wing.create({ data: { name, societyId: society_id } });

  let flatsCreated = 0;
  if (auto_generate_flats) {
    const flats: { number: string; floor: number; wingId: string }[] = [];
    if (layout_type === 'UNITS') {
      // Villas/bungalows/row houses laid out side by side, not stacked —
      // there's no meaningful "floor", so every unit sits on a single
      // nominal level and gets numbered sequentially instead.
      const prefix = unit_label?.trim() || name;
      for (let n = 1; n <= total_units!; n++) {
        flats.push({ number: `${prefix}-${String(n).padStart(2, '0')}`, floor: 1, wingId: wing.id });
      }
      flatsCreated = total_units!;
    } else {
      for (let floor = 1; floor <= total_floors!; floor++) {
        for (let flatNum = 1; flatNum <= flats_per_floor!; flatNum++) {
          flats.push({ number: `${name}-${floor}${String(flatNum).padStart(2, '0')}`, floor, wingId: wing.id });
        }
      }
      flatsCreated = total_floors! * flats_per_floor!;
    }
    await prisma.flat.createMany({ data: flats });
  }

  let secretaryActivation: ReturnType<typeof activationPayload> = null;
  if (secretary_name && secretary_phone) {
    const existing = await prisma.user.findUnique({ where: { phone: secretary_phone } });
    const conflict = phoneConflict(existing, { role: 'WING_ADMIN', wingId: wing.id });
    if (conflict) {
      // The wing itself is already created; report the problem without hiding that.
      return created(res, { ...wing, societyName: society.name, flatsCreated, secretaryError: conflict });
    }
    const secretary = await prisma.user.upsert({
      where: { phone: secretary_phone },
      create: { name: secretary_name, phone: secretary_phone, role: 'WING_ADMIN', societyId: society_id, wingId: wing.id, isPrimary: true },
      update: { name: secretary_name, role: 'WING_ADMIN', societyId: society_id, wingId: wing.id, isPrimary: true, isActive: true },
    });
    secretaryActivation = activationPayload(await codeIfNeeded(secretary.id, existing));
  }

  return created(res, { ...wing, societyName: society.name, flatsCreated, secretaryActivation });
}

export async function getWingDetail(req: Request, res: Response) {
  const { id } = req.params;

  const wing = await prisma.wing.findUnique({
    where: { id },
    include: {
      society: { select: { id: true, name: true } },
      flats: {
        include: {
          users: {
            // Include any active person assigned to this flat — RESIDENT or
            // WING_ADMIN (secretary who also lives in the building). Exclude
            // SUPER_ADMIN and GUARD who are never actual flat occupants.
            where: { isActive: true, role: { notIn: ['SUPER_ADMIN', 'GUARD'] } },
            select: { id: true, name: true, phone: true, residentType: true, role: true },
          },
        },
        orderBy: [{ floor: 'asc' }, { number: 'asc' }],
      },
      users: {
        where: { role: 'WING_ADMIN', isActive: true },
        select: { id: true, name: true, phone: true, isPrimary: true, pinSetAt: true, activationCodeHash: true, activationExpiresAt: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!wing) return notFound(res, 'Wing not found');

  // Show sign-in status (never the hashes) next to each Secretary.
  (wing as any).users = (wing.users as any[]).map(({ pinSetAt, activationCodeHash, activationExpiresAt, ...rest }) => ({
    ...rest,
    pin: pinSummaryOf({ pinSetAt, activationCodeHash, activationExpiresAt }),
  }));

  const totalFlats = wing.flats.length;
  const occupiedFlatsArr = wing.flats.filter((f) => f.users.length > 0);
  const occupiedFlats = occupiedFlatsArr.length;
  const totalResidents = occupiedFlatsArr.reduce((sum, f) => {
    const residentUsers = f.users.filter((u) => u.role === 'RESIDENT');
    const count = f.familyMembers > 0 ? f.familyMembers : residentUsers.length;
    return sum + count;
  }, 0);

  return ok(res, {
    ...wing,
    stats: { totalFlats, occupiedFlats, vacantFlats: totalFlats - occupiedFlats, totalResidents },
  });
}

// ─── Wing Flats ───────────────────────────────────────────────────────────────

const createFlatInWingSchema = z.object({
  number: z.string().min(1, 'Flat number is required'),
  floor: z.number().int().min(0),
  sqftSize: z.number().int().min(1).optional(),
});

export async function createFlatInWing(req: Request, res: Response) {
  const { wingId } = req.params;
  const parsed = createFlatInWingSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.errors[0].message);

  const wing = await prisma.wing.findUnique({ where: { id: wingId } });
  if (!wing) return notFound(res, 'Wing not found');

  const dup = await prisma.flat.findFirst({ where: { wingId, number: parsed.data.number } });
  if (dup) return badRequest(res, `Flat ${parsed.data.number} already exists in this wing`);

  const flat = await prisma.flat.create({ data: { ...parsed.data, wingId } as any });
  return created(res, flat);
}

// ─── Wing Secretary ───────────────────────────────────────────────────────────

const setSecretarySchema = z.object({
  name: z.string().min(2, 'Name is required'),
  phone: z.string().regex(/^[6-9]\d{9}$/, 'Invalid mobile number'),
  replaceUserId: z.string().optional(),
});

export async function setWingSecretary(req: Request, res: Response) {
  const { wingId } = req.params;
  const parsed = setSecretarySchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.errors[0].message);

  const { name, phone, replaceUserId } = parsed.data;

  const wing = await prisma.wing.findUnique({ where: { id: wingId } });
  if (!wing) return notFound(res, 'Wing not found');

  const existingForPhone = await prisma.user.findUnique({ where: { phone } });
  const conflict = phoneConflict(existingForPhone, { role: 'WING_ADMIN', wingId });
  // A resident of this same wing can be promoted; only block real conflicts.
  if (conflict && !(existingForPhone && existingForPhone.isActive && existingForPhone.wingId === wingId && existingForPhone.role === 'RESIDENT')) {
    return badRequest(res, conflict);
  }

  let isPrimaryForNew: boolean;

  if (replaceUserId) {
    const oldUser = await prisma.user.findUnique({ where: { id: replaceUserId } });
    if (!oldUser || oldUser.wingId !== wingId) return notFound(res, 'Secretary not found');
    isPrimaryForNew = oldUser.isPrimary;
    await prisma.session.deleteMany({ where: { userId: replaceUserId } });
    await prisma.user.update({ where: { id: replaceUserId }, data: { isActive: false, wingId: null } });
  } else {
    const existingAdmins = await prisma.user.findMany({
      where: { wingId, role: 'WING_ADMIN', isActive: true },
      select: { id: true },
    });
    if (existingAdmins.length >= 2) {
      return badRequest(res, 'Maximum 2 secretaries allowed per wing');
    }
    isPrimaryForNew = existingAdmins.length === 0;
  }

  const secretary = await prisma.user.upsert({
    where: { phone },
    create: { name, phone, role: 'WING_ADMIN', societyId: wing.societyId, wingId, isPrimary: isPrimaryForNew },
    update: { name, role: 'WING_ADMIN', societyId: wing.societyId, wingId, isPrimary: isPrimaryForNew, isActive: true },
  });
  const activation = activationPayload(await codeIfNeeded(secretary.id, existingForPhone));

  return created(res, { id: secretary.id, name: secretary.name, phone: secretary.phone, isPrimary: secretary.isPrimary, activation });
}

// ─── Wing Residents ───────────────────────────────────────────────────────────

export async function getWingResidents(req: Request, res: Response) {
  const { wingId } = req.params;

  const wing = await prisma.wing.findUnique({ where: { id: wingId } });
  if (!wing) return notFound(res, 'Wing not found');

  const residents = await prisma.user.findMany({
    where: { wingId, role: 'RESIDENT', isActive: true },
    select: {
      id: true, name: true, phone: true, residentType: true,
      flat: { select: { id: true, number: true, floor: true } },
    },
    orderBy: { name: 'asc' },
  });

  return ok(res, residents);
}

// ─── Flat Detail ──────────────────────────────────────────────────────────────

export async function getFlatDetail(req: Request, res: Response) {
  const { flatId } = req.params;

  const flat = await prisma.flat.findUnique({
    where: { id: flatId },
    include: {
      wing: { select: { id: true, name: true, society: { select: { name: true } } } },
      vehicles: { select: { id: true, type: true, plateNumber: true } },
      users: {
        // Same rule: show any active flat occupant, regardless of role,
        // except SUPER_ADMIN and GUARD who are never flat residents.
        where: { isActive: true, role: { notIn: ['SUPER_ADMIN', 'GUARD'] } },
        select: { id: true, name: true, phone: true, residentType: true },
      },
      bills: {
        orderBy: { createdAt: 'desc' },
        take: 3,
        select: { id: true, amount: true, month: true, year: true, status: true, dueDate: true },
      },
    },
  });

  if (!flat) return notFound(res, 'Flat not found');
  return ok(res, flat);
}

// ─── Resident management ─────────────────────────────────────────────────────

const residentItemSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  phone: z.string().regex(/^[6-9]\d{9}$/, 'Invalid mobile number'),
  resident_type: z.enum(['OWNER', 'TENANT']).default('OWNER'),
});

const addResidentToFlatSchema = z.object({
  residents: z.array(residentItemSchema).min(1).max(2),
  family_members: z.number().int().min(1).max(6).default(1),
});

export async function addResidentToFlat(req: Request, res: Response) {
  const { flatId } = req.params;
  const parsed = addResidentToFlatSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.errors[0].message);

  const flat = await prisma.flat.findUnique({
    where: { id: flatId },
    include: { wing: { select: { societyId: true } } },
  });
  if (!flat) return notFound(res, 'Flat not found');

  const currentCount = await prisma.user.count({ where: { flatId, role: 'RESIDENT', isActive: true } });
  if (currentCount + parsed.data.residents.length > 2) {
    return badRequest(res, `This flat already has ${currentCount} resident${currentCount !== 1 ? 's' : ''}. Maximum 2 logins allowed per flat.`);
  }

  // Check every number before creating anyone, so a conflict never leaves half the flat added.
  const before = new Map<string, any>();
  for (const r of parsed.data.residents) {
    const existing = await prisma.user.findUnique({ where: { phone: r.phone } });
    const conflict = phoneConflict(existing, { role: 'RESIDENT', wingId: flat.wingId });
    if (conflict) return badRequest(res, `${r.phone}: ${conflict}`);
    before.set(r.phone, existing);
  }

  const results = [];
  for (const r of parsed.data.residents) {
    const user = await prisma.user.upsert({
      where: { phone: r.phone },
      create: {
        name: r.name,
        phone: r.phone,
        role: 'RESIDENT',
        residentType: r.resident_type,
        familyMembers: parsed.data.family_members,
        societyId: flat.wing.societyId,
        wingId: flat.wingId,
        flatId,
      },
      update: {
        name: r.name,
        residentType: r.resident_type,
        familyMembers: parsed.data.family_members,
        wingId: flat.wingId,
        flatId,
        isActive: true,
      },
    });
    const activation = activationPayload(await codeIfNeeded(user.id, before.get(r.phone) ?? null));
    results.push({ id: user.id, name: user.name, phone: user.phone, activation });
  }

  // Write familyMembers to the Flat record so the Super Admin resident count is correct.
  // Without this, getStats/getSocieties would see familyMembers=0 and fall back to user count.
  console.log(`[addResidentToFlat] Saving familyMembers=${parsed.data.family_members} to flat ${flatId}`);
  await prisma.flat.update({
    where: { id: flatId },
    data: { familyMembers: parsed.data.family_members },
  });

  return created(res, results, 'Resident(s) added');
}

export async function removeResidentAdmin(req: Request, res: Response) {
  const { id } = req.params;

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user || user.role !== 'RESIDENT') return notFound(res, 'Resident not found');

  await prisma.user.update({ where: { id }, data: { isActive: false, flatId: null } });
  return ok(res, null, 'Resident removed');
}

// ─── Delete Wing ──────────────────────────────────────────────────────────────

export async function deleteWing(req: Request, res: Response) {
  const { wingId } = req.params;
  try {
    const wing = await prisma.wing.findUnique({ where: { id: wingId } });
    if (!wing) return res.status(404).json({ success: false, message: 'Wing not found' });

    const flats = await prisma.flat.findMany({ where: { wingId }, select: { id: true } });
    const flatIds = flats.map((f) => f.id);

    if (flatIds.length > 0) {
      await prisma.maintenanceBill.deleteMany({ where: { flatId: { in: flatIds } } });
      await prisma.vehicle.deleteMany({ where: { flatId: { in: flatIds } } });
    }

    const notices = await prisma.notice.findMany({ where: { wingId }, select: { id: true } });
    if (notices.length > 0) {
      await prisma.noticeSeen.deleteMany({ where: { noticeId: { in: notices.map((n) => n.id) } } });
    }

    await prisma.visitor.deleteMany({ where: { wingId } });
    await prisma.complaint.deleteMany({ where: { wingId } });
    await prisma.notice.deleteMany({ where: { wingId } });

    await prisma.session.deleteMany({
      where: { user: { wingId, role: { notIn: ['SUPER_ADMIN', 'GUARD'] } } },
    });

    await prisma.user.updateMany({
      where: { wingId, role: { in: ['SUPER_ADMIN', 'GUARD'] } },
      data: { wingId: null },
    });

    await prisma.user.deleteMany({
      where: { wingId, role: { notIn: ['SUPER_ADMIN', 'GUARD'] } },
    });

    await prisma.flat.deleteMany({ where: { wingId } });
    await prisma.wing.delete({ where: { id: wingId } });

    return res.json({ success: true, message: 'Wing deleted successfully' });
  } catch (error: any) {
    console.error('Delete wing error:', error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
}


// ─── Reset someone's PIN (forgotten PIN, or handing an account to a new person) ──
export async function resetUserPin(req: Request, res: Response) {
  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user || !user.isActive || user.role === 'GUARD') return notFound(res, 'User not found');
  if (user.role === 'SUPER_ADMIN') {
    return badRequest(res, 'Platform administrators are reset by the platform owner, not from here.');
  }
  const issued = await issueActivationCode(user.id, { resetPin: true });
  return ok(res, { name: user.name, phone: user.phone, activation: activationPayload(issued) }, 'PIN reset. Share the new code.');
}

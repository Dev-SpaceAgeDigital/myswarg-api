import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { ok, badRequest, notFound } from '../utils/response';
import { codeIfNeeded, phoneConflict, formatActivationCode } from '../services/pin.service';

/**
 * Bulk onboarding from a spreadsheet (Command Centre → wing → Import).
 *
 * The Command Centre reads the Excel/CSV file and sends plain rows. The server
 * re-checks every row (never trusting the browser), and can run in two modes:
 *   dryRun: true  → only report what would happen to each row (the preview)
 *   dryRun: false → create flats and residents for the valid rows
 * One bad row never stops the others; every row gets its own result.
 */

const MAX_ROWS = 1000;
const MAX_RESIDENTS_PER_FLAT = 2;

const rowSchema = z.object({
  row: z.number().int(),
  flat: z.string().optional().default(''),
  floor: z.union([z.number(), z.string()]).optional().nullable(),
  name: z.string().optional().default(''),
  phone: z.union([z.string(), z.number()]).optional().nullable(),
  type: z.string().optional().nullable(),
  family: z.union([z.number(), z.string()]).optional().nullable(),
});
const bodySchema = z.object({ rows: z.array(rowSchema).max(MAX_ROWS), dryRun: z.boolean().default(true) });

export type RowStatus = 'ready' | 'created' | 'skipped' | 'error';
export interface RowResult {
  row: number;
  flat: string;
  name: string;
  phone: string;
  status: RowStatus;
  message: string;
  activationCode?: string;
  activationExpiresAt?: string;
}

const cleanPhone = (v: unknown) => {
  let d = String(v ?? '').replace(/[^0-9]/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2); // +91 98xxxxxxxx
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
};

function floorFrom(flat: string, given: unknown): number | null {
  if (given !== undefined && given !== null && String(given).trim() !== '') {
    const n = Number(String(given).trim());
    return Number.isInteger(n) && n >= 0 && n <= 200 ? n : null;
  }
  const digits = flat.match(/(\d+)\s*$/)?.[1];
  if (!digits) return 0;
  const n = parseInt(digits, 10);
  return n >= 100 ? Math.floor(n / 100) : 0; // 101 → 1, 1204 → 12, 7 → 0
}

function typeFrom(v: unknown): 'OWNER' | 'TENANT' | null {
  const t = String(v ?? '').trim().toLowerCase();
  if (!t || t === 'owner' || t === 'o') return 'OWNER';
  if (t === 'tenant' || t === 't' || t === 'rent' || t === 'renter') return 'TENANT';
  return null;
}

export async function importWingData(req: Request, res: Response) {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return badRequest(res, parsed.error.errors[0]?.message?.includes('1000') ? `Import up to ${MAX_ROWS} rows at a time.` : 'The file could not be read. Please use the template.');
  }
  const { rows, dryRun } = parsed.data;
  if (!rows.length) return badRequest(res, 'The file has no rows.');

  const wing = await prisma.wing.findUnique({ where: { id: req.params.wingId }, select: { id: true, societyId: true, name: true } });
  if (!wing) return notFound(res, 'Wing not found');

  // ── Load what already exists, once ──
  const flats = await prisma.flat.findMany({
    where: { wingId: wing.id },
    select: { id: true, number: true, users: { where: { role: 'RESIDENT', isActive: true }, select: { phone: true } } },
  });
  const flatByKey = new Map(flats.map((f) => [f.number.trim().toLowerCase(), f]));
  const residentCount = new Map(flats.map((f) => [f.id, f.users.length]));
  const pendingNewFlatCount = new Map<string, number>(); // residents planned for flats not created yet (dry run)

  const phones = Array.from(new Set(rows.map((r) => cleanPhone(r.phone)).filter((p) => p.length === 10)));
  const existingUsers = await prisma.user.findMany({
    where: { phone: { in: phones } },
    select: { id: true, phone: true, role: true, wingId: true, flatId: true, isActive: true, pinHash: true, flat: { select: { number: true } } },
  });
  const userByPhone = new Map(existingUsers.map((u) => [u.phone, u]));

  const seenPhones = new Map<string, number>(); // phone → first row number
  const results: RowResult[] = [];
  let created = 0, skipped = 0, errors = 0, flatsCreated = 0;

  for (const r of rows) {
    const flat = String(r.flat ?? '').trim();
    const name = String(r.name ?? '').trim();
    const phone = cleanPhone(r.phone);
    const base = { row: r.row, flat, name, phone };
    const fail = (message: string) => { errors++; results.push({ ...base, status: 'error', message }); };
    const skip = (message: string) => { skipped++; results.push({ ...base, status: 'skipped', message }); };

    // ── Checks that need nothing from the database ──
    if (!flat) { fail('Flat number is missing.'); continue; }
    if (flat.length > 20) { fail('Flat number is too long.'); continue; }
    const floor = floorFrom(flat, r.floor);
    if (floor === null) { fail('Floor must be a whole number.'); continue; }

    const hasResident = !!name || !!String(r.phone ?? '').trim();
    if (hasResident) {
      if (!name) { fail('Resident name is missing.'); continue; }
      if (!/^[6-9]\d{9}$/.test(phone)) { fail('Mobile number must be 10 digits and start with 6, 7, 8 or 9.'); continue; }
      const firstRow = seenPhones.get(phone);
      if (firstRow !== undefined) { fail(`This mobile number already appears in row ${firstRow}.`); continue; }
      seenPhones.set(phone, r.row);
    }
    const type = typeFrom(r.type);
    if (hasResident && !type) { fail('Type must be Owner or Tenant.'); continue; }
    let family = 1;
    if (r.family !== undefined && r.family !== null && String(r.family).trim() !== '') {
      family = Number(String(r.family).trim());
      if (!Number.isInteger(family) || family < 1 || family > 20) { fail('Family members must be a number from 1 to 20.'); continue; }
    }

    // ── Checks against what already exists ──
    const key = flat.toLowerCase();
    const existingFlat = flatByKey.get(key);
    const existingUser = phone ? userByPhone.get(phone) : undefined;

    if (hasResident && existingUser) {
      if (existingUser.isActive && existingUser.role === 'RESIDENT' && existingUser.wingId === wing.id && existingFlat && existingUser.flatId === existingFlat.id) {
        skip('Already added to this flat.');
        continue;
      }
      if (existingUser.isActive && existingUser.role === 'RESIDENT' && existingUser.wingId === wing.id && existingUser.flatId) {
        fail(`Already registered in Flat ${existingUser.flat?.number ?? ''} of this wing.`);
        continue;
      }
      const conflict = phoneConflict(existingUser, { role: 'RESIDENT', wingId: wing.id });
      if (conflict) { fail(conflict); continue; }
    }

    if (hasResident) {
      const count = existingFlat ? residentCount.get(existingFlat.id) ?? 0 : pendingNewFlatCount.get(key) ?? 0;
      if (count >= MAX_RESIDENTS_PER_FLAT) { fail(`Flat ${flat} already has ${MAX_RESIDENTS_PER_FLAT} residents (the maximum).`); continue; }
    }

    if (!hasResident && existingFlat) { skip('Flat already exists.'); continue; }

    // ── Preview only ──
    if (dryRun) {
      const firstRowOfNewFlat = !existingFlat && !pendingNewFlatCount.has(key);
      if (!existingFlat) {
        if (firstRowOfNewFlat) flatsCreated++;
        pendingNewFlatCount.set(key, (pendingNewFlatCount.get(key) ?? 0) + (hasResident ? 1 : 0));
      } else if (hasResident) {
        residentCount.set(existingFlat.id, (residentCount.get(existingFlat.id) ?? 0) + 1);
      }
      created++;
      const who = type === 'TENANT' ? 'tenant' : 'owner';
      results.push({
        ...base, status: 'ready',
        message: !hasResident ? 'New flat will be created'
          : firstRowOfNewFlat ? `New flat and ${who} will be added`
          : `${who.charAt(0).toUpperCase() + who.slice(1)} will be added`,
      });
      continue;
    }

    // ── Write ──
    try {
      let flatId = existingFlat?.id;
      if (!flatId) {
        const f = await prisma.flat.create({ data: { number: flat, floor, wingId: wing.id } });
        flatId = f.id;
        flatByKey.set(key, { id: f.id, number: f.number, users: [] });
        residentCount.set(f.id, 0);
        flatsCreated++;
      }
      if (!hasResident) {
        created++;
        results.push({ ...base, status: 'created', message: 'Flat created' });
        continue;
      }
      const before = existingUser ?? null;
      const user = await prisma.user.upsert({
        where: { phone },
        create: {
          name, phone, role: 'RESIDENT', residentType: type!, familyMembers: family,
          societyId: wing.societyId, wingId: wing.id, flatId, isPrimary: (residentCount.get(flatId) ?? 0) === 0,
        },
        update: {
          name, role: 'RESIDENT', residentType: type!, familyMembers: family,
          societyId: wing.societyId, wingId: wing.id, flatId, isActive: true,
        },
      });
      residentCount.set(flatId, (residentCount.get(flatId) ?? 0) + 1);
      await prisma.flat.update({ where: { id: flatId }, data: { familyMembers: family } });
      const issued = await codeIfNeeded(user.id, before as any);
      created++;
      results.push({
        ...base, status: 'created', message: existingFlat ? 'Resident added' : 'Flat and resident added',
        ...(issued ? { activationCode: formatActivationCode(issued.code), activationExpiresAt: issued.expiresAt.toISOString() } : {}),
      });
    } catch (err: any) {
      console.error('[importWingData] row', r.row, err?.message ?? err);
      fail('Could not save this row. Please try again.');
    }
  }

  return ok(res, {
    dryRun,
    wingName: wing.name,
    summary: { total: rows.length, ok: created, skipped, errors, flatsCreated },
    results,
  });
}

import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { ok, created, badRequest, notFound } from '../utils/response';
import { uploadPrivateBuffer, getSignedDownloadUrl } from '../services/upload.service';
import { notifyWingAdmins, notifyUsers, notifyFlat, residentLabel } from '../services/notification.service';

const generateBillsSchema = z.object({
  amount: z.number().positive(),
  month: z.number().min(1).max(12),
  year: z.number().min(2024),
  due_date: z.string().datetime(),
});

const markPaidSchema = z.object({
  payment_mode: z.enum(['CASH', 'CHEQUE', 'UPI']),
});

const VALID_STATUSES = ['PENDING', 'PAID', 'OVERDUE', 'PENDING_VERIFICATION'] as const;
type ValidStatus = typeof VALID_STATUSES[number];

// Flips PENDING bills past the wing's grace period into OVERDUE and freezes
// the late fee onto the bill. No cron infra exists yet, so this runs lazily
// on every read that touches bills for a wing — cheap (one wing lookup +
// one bulk update) and keeps status/lateFeeApplied accurate without a job.
async function syncWingOverdueBills(wingId: string) {
  const wing = await prisma.wing.findUnique({
    where: { id: wingId },
    select: { lateFeeAmount: true, lateFeeGraceDays: true },
  });
  if (!wing || wing.lateFeeAmount <= 0) return;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - wing.lateFeeGraceDays);

  await prisma.maintenanceBill.updateMany({
    where: { wingId, status: 'PENDING', dueDate: { lt: cutoff } },
    data: { status: 'OVERDUE', lateFeeApplied: wing.lateFeeAmount },
  });
}

function withTotalDue<T extends { amount: number; lateFeeApplied: number }>(bill: T) {
  return { ...bill, totalDue: bill.amount + bill.lateFeeApplied };
}

export async function listBills(req: Request, res: Response) {
  try {
    const wingId = req.user.wing_id;
    console.log('[listBills] User wing_id:', wingId, 'role:', req.user.role);

    if (!wingId) {
      return res.status(400).json({
        success: false,
        message: 'Wing not assigned.',
      });
    }

    const month = req.query.month ? parseInt(req.query.month as string, 10) : undefined;
    const year = req.query.year ? parseInt(req.query.year as string, 10) : undefined;
    const statusParam = req.query.status as string | undefined;
    const statusFilter = statusParam && (VALID_STATUSES as readonly string[]).includes(statusParam)
      ? (statusParam as ValidStatus)
      : undefined;

    const baseWhere =
      req.user.role === 'RESIDENT'
        ? { wingId, flatId: req.user.flat_id ?? undefined }
        : { wingId };

    const where = {
      ...baseWhere,
      ...(month !== undefined && !isNaN(month) ? { month } : {}),
      ...(year !== undefined && !isNaN(year) ? { year } : {}),
      ...(statusFilter ? { status: statusFilter } : {}),
    };

    await syncWingOverdueBills(wingId);

    const bills = await prisma.maintenanceBill.findMany({
      where,
      include: { flat: { select: { number: true, floor: true } } },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
    return ok(res, bills.map(withTotalDue));
  } catch (err: any) {
    console.error('[listBills] Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function getDistinctMonths(req: Request, res: Response) {
  const bills = await prisma.maintenanceBill.findMany({
    where: { wingId: req.user.wing_id },
    select: { month: true, year: true, status: true },
  });

  const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  const map = new Map<string, { month: number; year: number; total: number; pending: number; paid: number }>();
  for (const bill of bills) {
    const key = `${bill.year}-${String(bill.month).padStart(2, '0')}`;
    if (!map.has(key)) {
      map.set(key, { month: bill.month, year: bill.year, total: 0, pending: 0, paid: 0 });
    }
    const entry = map.get(key)!;
    entry.total++;
    if (bill.status === 'PENDING' || bill.status === 'OVERDUE') entry.pending++;
    if (bill.status === 'PAID') entry.paid++;
  }

  const result = Array.from(map.values())
    .sort((a, b) => b.year !== a.year ? b.year - a.year : b.month - a.month)
    .map((entry) => ({
      ...entry,
      label: `${MONTH_NAMES[entry.month - 1]} ${entry.year}`,
    }));

  return ok(res, result);
}

export async function generateBills(req: Request, res: Response) {
  const parsed = generateBillsSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.errors[0].message);

  const { amount, month, year, due_date } = parsed.data;
  const wingId = req.user.wing_id;

  console.log('[generateBills] wingId:', wingId, 'month:', month, 'year:', year, 'amount:', amount);

  if (!wingId) {
    return res.status(400).json({ success: false, message: 'Wing not assigned' });
  }

  // Reject if bills already exist for this month/year
  const existingCount = await prisma.maintenanceBill.count({ where: { wingId, month, year } });
  if (existingCount > 0) {
    return res.status(400).json({
      success: false,
      message: `Bills already generated for this month. ${existingCount} bills exist.`,
    });
  }

  const [allFlats, occupiedFlats] = await Promise.all([
    prisma.flat.findMany({ where: { wingId }, select: { id: true } }),
    prisma.flat.findMany({
      where: {
        wingId,
        OR: [
          { users: { some: { role: 'RESIDENT', isActive: true } } },
          { familyMembers: { gt: 0 } },
        ],
      },
      select: { id: true, number: true, floor: true, familyMembers: true },
    }),
  ]);

  console.log('[generateBills] All flats:', allFlats.length, 'Occupied:', occupiedFlats.length);
  console.log('[generateBills] Occupied flat numbers:', occupiedFlats.map((f) => f.number).join(', '));

  if (allFlats.length === 0) return badRequest(res, 'No flats found in wing');
  if (occupiedFlats.length === 0) {
    return res.status(400).json({
      success: false,
      message: `No occupied flats found. Total flats in wing: ${allFlats.length}. Add residents or set family count before generating bills.`,
    });
  }

  const skipped = allFlats.length - occupiedFlats.length;

  const bills = await Promise.all(
    occupiedFlats.map((flat) =>
      prisma.maintenanceBill.create({
        data: { flatId: flat.id, wingId, amount, month, year, dueDate: new Date(due_date), status: 'PENDING' },
      }),
    ),
  );

  // Tell every resident of those flats that a new bill is waiting.
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  prisma.user
    .findMany({
      where: { flatId: { in: occupiedFlats.map((f) => f.id) }, isActive: true, role: 'RESIDENT' },
      select: { id: true },
    })
    .then((people) =>
      notifyUsers({
        userIds: people.map((p) => p.id),
        title: 'New maintenance bill',
        body: `Your ${MONTHS[month - 1]} ${year} bill of ₹${amount} is ready. Due ${new Date(due_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}.`,
        type: 'BILL_GENERATED',
      }),
    )
    .catch((e) => console.error('[generateBills] notify failed:', e?.message ?? e));

  const generated = bills.length;
  const message = `Bills generated for ${generated} occupied flat${generated !== 1 ? 's' : ''}. ${skipped} vacant flat${skipped !== 1 ? 's' : ''} skipped.`;

  return created(res, { generated, skipped, message }, message);
}

export async function getBillById(req: Request, res: Response) {
  const { id } = req.params;
  const billScope =
    req.user.role === 'RESIDENT'
      ? { id, wingId: req.user.wing_id, flatId: req.user.flat_id ?? undefined }
      : { id, wingId: req.user.wing_id };

  const existing = await prisma.maintenanceBill.findFirst({ where: billScope, select: { wingId: true } });
  if (!existing) return notFound(res, 'Bill not found');
  await syncWingOverdueBills(existing.wingId);

  const raw = await prisma.maintenanceBill.findFirst({
    where: billScope,
    include: {
      flat: {
        select: {
          number: true,
          floor: true,
          wing: {
            select: {
              users: {
                where: { role: 'WING_ADMIN' },
                select: { name: true, phone: true, upiId: true },
                take: 1,
              },
            },
          },
        },
      },
    },
  });
  if (!raw) return notFound(res, 'Bill not found');
  const { flat, proofPublicId, proofResourceType, proofFormat, ...rest } = raw;
  const sec = flat?.wing?.users?.[0];
  return ok(res, {
    ...withTotalDue(rest),
    flat: flat ? { number: flat.number, floor: flat.floor } : null,
    secretary: {
      name: sec?.name ?? '',
      phone: sec?.phone ?? '',
      upiId: sec?.upiId ?? null,
    },
    hasPaymentProof: !!proofPublicId,
  });
}

export async function getBillPaymentProofUrl(req: Request, res: Response) {
  const { id: billId } = req.params;
  const bill = await prisma.maintenanceBill.findFirst({
    where: { id: billId, wingId: req.user.wing_id },
  });
  if (!bill || !bill.proofPublicId) return notFound(res, 'Payment proof not found');

  const url = getSignedDownloadUrl(bill.proofPublicId, bill.proofResourceType!, bill.proofFormat);
  return ok(res, { url, expiresInSeconds: 300 });
}

export async function claimUpiPayment(req: Request, res: Response) {
  const { id: billId } = req.params;
  const flatId = req.user.flat_id;
  if (!flatId) return badRequest(res, 'No flat associated with your account');

  const existing = await prisma.maintenanceBill.findUnique({ where: { id: billId }, select: { wingId: true } });
  if (existing) await syncWingOverdueBills(existing.wingId);

  const bill = await prisma.maintenanceBill.findFirst({
    where: { id: billId, flatId, status: { in: ['PENDING', 'OVERDUE'] } },
  });
  if (!bill) return notFound(res, 'Bill not found or already processed');

  let proofFields: { proofPublicId?: string; proofResourceType?: string; proofFormat?: string | null } = {};
  if (req.file) {
    try {
      const uploadResult = await uploadPrivateBuffer(req.file.buffer, `payment-proof/${flatId}`);
      proofFields = {
        proofPublicId: uploadResult.publicId,
        proofResourceType: uploadResult.resourceType,
        proofFormat: uploadResult.format,
      };
    } catch (err: any) {
      console.error('[claimUpiPayment] Screenshot upload failed:', err.message);
      // Don't block the payment claim if the screenshot upload fails —
      // the secretary can still verify manually via UPI app history.
    }
  }

  const updated = await prisma.maintenanceBill.update({
    where: { id: billId },
    data: { status: 'PENDING_VERIFICATION', paymentMode: 'UPI', ...proofFields },
    include: { flat: { select: { number: true, floor: true } } },
  });
  residentLabel(req.user.user_id).then((who) =>
    notifyWingAdmins({
      wingId: updated.wingId,
      title: 'Payment awaiting verification',
      body: `${who} paid ₹${updated.amount} by UPI${req.file ? ' and attached a screenshot' : ''}. Please verify.`,
      type: 'PAYMENT_CLAIMED',
      relatedId: updated.id,
    }),
  );
  return ok(res, updated, 'Payment claimed. Awaiting secretary verification.');
}

export async function confirmPayment(req: Request, res: Response) {
  const { id: billId } = req.params;
  const bill = await prisma.maintenanceBill.findFirst({
    where: { id: billId, wingId: req.user.wing_id, status: 'PENDING_VERIFICATION' },
  });
  if (!bill) return notFound(res, 'Bill not found or not awaiting verification');

  const updated = await prisma.maintenanceBill.update({
    where: { id: billId },
    data: { status: 'PAID', paidAt: new Date() },
    include: { flat: { select: { number: true, floor: true } } },
  });
  notifyFlat({
    flatId: updated.flatId,
    title: 'Payment confirmed',
    body: `Your payment of ₹${updated.amount} was verified. Thank you!`,
    type: 'PAYMENT_CONFIRMED',
    relatedId: updated.id,
  });
  return ok(res, updated, 'Payment confirmed');
}

export async function rejectPayment(req: Request, res: Response) {
  const { id: billId } = req.params;
  const bill = await prisma.maintenanceBill.findFirst({
    where: { id: billId, wingId: req.user.wing_id, status: 'PENDING_VERIFICATION' },
  });
  if (!bill) return notFound(res, 'Bill not found or not awaiting verification');

  const updated = await prisma.maintenanceBill.update({
    where: { id: billId },
    data: { status: 'PENDING', paymentMode: null },
    include: { flat: { select: { number: true, floor: true } } },
  });
  notifyFlat({
    flatId: updated.flatId,
    title: 'Payment not verified',
    body: `Your payment of ₹${updated.amount} could not be verified. Please pay again or contact your Secretary.`,
    type: 'PAYMENT_REJECTED',
    relatedId: updated.id,
  });
  return ok(res, updated, 'Payment rejected. Bill reset to pending.');
}

export async function markPaid(req: Request, res: Response) {
  const parsed = markPaidSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.errors[0].message);

  const bill = await prisma.maintenanceBill.findFirst({
    where: { id: req.params.id, wingId: req.user.wing_id },
  });
  if (!bill) return notFound(res, 'Bill not found');
  if (bill.status === 'PAID') return badRequest(res, 'This bill is already marked as paid');

  const updatedBill = await prisma.maintenanceBill.update({
    where: { id: req.params.id },
    data: { status: 'PAID', paymentMode: parsed.data.payment_mode, paidAt: new Date() },
    include: { flat: { select: { number: true, floor: true } } },
  });
  notifyFlat({
    flatId: updatedBill.flatId,
    title: 'Payment received',
    body: `Your payment of ₹${updatedBill.amount} was recorded as paid (${parsed.data.payment_mode.toLowerCase()}).`,
    type: 'PAYMENT_CONFIRMED',
    relatedId: updatedBill.id,
  });
  return ok(res, updatedBill, 'Bill marked as paid');
}

export async function initiateUpiPayment(req: Request, res: Response) {
  const bill = await prisma.maintenanceBill.findFirst({
    where: { id: req.params.id, wingId: req.user.wing_id, flatId: req.user.flat_id ?? undefined },
  });
  if (!bill) return notFound(res, 'Bill not found');

  // Return UPI payment link — actual UPI ID to be configured per society
  const upiLink = `upi://pay?pa=nivasi@upi&am=${bill.amount}&tn=Maintenance+${bill.month}/${bill.year}&cu=INR`;
  return ok(res, { upi_link: upiLink, amount: bill.amount });
}

export async function getBillingSummary(req: Request, res: Response) {
  const [paid, pending, overdue, pendingVerification] = await Promise.all([
    prisma.maintenanceBill.count({ where: { wingId: req.user.wing_id, status: 'PAID' } }),
    prisma.maintenanceBill.count({ where: { wingId: req.user.wing_id, status: 'PENDING' } }),
    prisma.maintenanceBill.count({ where: { wingId: req.user.wing_id, status: 'OVERDUE' } }),
    prisma.maintenanceBill.count({ where: { wingId: req.user.wing_id, status: 'PENDING_VERIFICATION' } }),
  ]);

  const totalCollected = await prisma.maintenanceBill.aggregate({
    where: { wingId: req.user.wing_id, status: 'PAID' },
    _sum: { amount: true },
  });

  return ok(res, {
    paid, pending, overdue,
    pending_verification: pendingVerification,
    total_collected: totalCollected._sum.amount ?? 0,
  });
}

export async function getLateFeeSettings(req: Request, res: Response) {
  const wing = await prisma.wing.findUnique({
    where: { id: req.user.wing_id },
    select: { lateFeeAmount: true, lateFeeGraceDays: true },
  });
  if (!wing) return notFound(res, 'Wing not found');
  return ok(res, wing);
}

const lateFeeSettingsSchema = z.object({
  late_fee_amount: z.number().min(0),
  grace_period_days: z.number().int().min(0),
});

export async function updateLateFeeSettings(req: Request, res: Response) {
  const parsed = lateFeeSettingsSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.errors[0].message);

  const wing = await prisma.wing.update({
    where: { id: req.user.wing_id },
    data: { lateFeeAmount: parsed.data.late_fee_amount, lateFeeGraceDays: parsed.data.grace_period_days },
  });
  return ok(res, { lateFeeAmount: wing.lateFeeAmount, lateFeeGraceDays: wing.lateFeeGraceDays }, 'Late fee settings updated');
}

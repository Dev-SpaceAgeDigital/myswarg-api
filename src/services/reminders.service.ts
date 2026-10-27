import { prisma } from '../config/db';
import { notifyFlat } from './notification.service';

/**
 * Automatic bill reminders, checked every few hours by the API itself:
 *  - 3 days before the due date: "your bill is due soon"
 *  - the day after the due date, if still unpaid: "your bill is overdue"
 * Each reminder goes out once per bill (the sent time is saved on the bill),
 * and only during the day in India so nobody is woken at night.
 */

const DAY = 24 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CHECK_EVERY_MS = 3 * 60 * 60 * 1000;

function indiaHour(now = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(now));
}

const fmtDate = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

export async function runBillReminders(now = new Date()): Promise<{ dueSoon: number; overdue: number }> {
  const hour = indiaHour(now);
  if (hour < 9 || hour >= 20) return { dueSoon: 0, overdue: 0 };

  const dueSoon = await prisma.maintenanceBill.findMany({
    where: {
      status: 'PENDING',
      dueReminderSentAt: null,
      dueDate: { gte: now, lte: new Date(now.getTime() + 3 * DAY) },
    } as any,
    select: { id: true, flatId: true, amount: true, month: true, year: true, dueDate: true },
    take: 500,
  });
  for (const b of dueSoon) {
    await notifyFlat({
      flatId: b.flatId,
      title: 'Maintenance bill due soon',
      body: `Your ${MONTHS[b.month - 1]} ${b.year} bill of ₹${b.amount} is due on ${fmtDate(b.dueDate)}.`,
      type: 'BILL_DUE_SOON',
      relatedId: b.id,
    });
    await prisma.maintenanceBill.update({ where: { id: b.id }, data: { dueReminderSentAt: now } as any });
  }

  const overdue = await prisma.maintenanceBill.findMany({
    where: {
      status: { in: ['PENDING', 'OVERDUE'] },
      overdueReminderSentAt: null,
      dueDate: { lt: new Date(now.getTime() - DAY) },
    } as any,
    select: { id: true, flatId: true, amount: true, month: true, year: true, dueDate: true },
    take: 500,
  });
  for (const b of overdue) {
    await notifyFlat({
      flatId: b.flatId,
      title: 'Maintenance bill overdue',
      body: `Your ${MONTHS[b.month - 1]} ${b.year} bill of ₹${b.amount} was due on ${fmtDate(b.dueDate)}. Please pay to avoid a late fee.`,
      type: 'BILL_OVERDUE',
      relatedId: b.id,
    });
    await prisma.maintenanceBill.update({ where: { id: b.id }, data: { overdueReminderSentAt: now } as any });
  }

  return { dueSoon: dueSoon.length, overdue: overdue.length };
}

export function startReminderSchedule() {
  const tick = () =>
    runBillReminders()
      .then((r) => { if (r.dueSoon || r.overdue) console.log('[reminders] sent', r); })
      .catch((e) => console.error('[reminders] failed:', e?.message ?? e));
  setTimeout(tick, 60 * 1000); // shortly after start-up
  setInterval(tick, CHECK_EVERY_MS);
}

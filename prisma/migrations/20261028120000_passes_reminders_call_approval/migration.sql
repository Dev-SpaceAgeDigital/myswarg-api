-- Visitor passes (daily help, drivers, regular deliveries)
ALTER TABLE "GuestInvite" ADD COLUMN IF NOT EXISTS "isPass" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GuestInvite" ADD COLUMN IF NOT EXISTS "validUntil" TIMESTAMP(3);
ALTER TABLE "GuestInvite" ADD COLUMN IF NOT EXISTS "useCount" INTEGER NOT NULL DEFAULT 0;

-- Automatic bill reminders, sent once each
ALTER TABLE "MaintenanceBill" ADD COLUMN IF NOT EXISTS "dueReminderSentAt" TIMESTAMP(3);
ALTER TABLE "MaintenanceBill" ADD COLUMN IF NOT EXISTS "overdueReminderSentAt" TIMESTAMP(3);

-- How a visitor's entry was allowed
ALTER TABLE "Visitor" ADD COLUMN IF NOT EXISTS "approvalMethod" TEXT;

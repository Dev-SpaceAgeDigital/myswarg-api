-- Society code for guard sign-in (unique, 6 characters), filled in for existing societies.
ALTER TABLE "Society" ADD COLUMN IF NOT EXISTS "code" TEXT;
UPDATE "Society" SET "code" = upper(substr(md5(random()::text || "id"), 1, 6)) WHERE "code" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "Society_code_key" ON "Society"("code");

-- Guard PINs move to a hashed column.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "guardPinHash" TEXT;

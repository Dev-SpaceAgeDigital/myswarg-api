/**
 * One-off helper: issues a fresh one-time activation code for any account —
 * used to set up the very first Super Admin (and to recover one), since
 * Super Admins are not reset from inside the apps.
 *
 * Run it on the server (Railway → myswarg-api → Console):
 *     node dist/scripts/issueActivationCode.js 9XXXXXXXXX
 *
 * If the Super Admin does not exist yet (fresh database), create them too:
 *     node dist/scripts/issueActivationCode.js 9XXXXXXXXX --create-super-admin "Your Name"
 *
 * The person then opens the app (or Command Centre), enters their phone number,
 * the code shown here, and chooses their own PIN. The old PIN (if any) stops working.
 */
import { prisma } from '../config/db';
import { issueActivationCode } from '../services/pin.service';

async function main() {
  const phone = String(process.argv[2] ?? '').replace(/[^0-9]/g, '');
  if (!/^[6-9]\d{9}$/.test(phone)) {
    console.error('Usage: node dist/scripts/issueActivationCode.js <10-digit phone>');
    process.exit(1);
  }
  let user = await prisma.user.findUnique({ where: { phone } });
  const createFlag = process.argv.indexOf('--create-super-admin');
  if (createFlag !== -1 && !user) {
    const name = (process.argv[createFlag + 1] ?? '').trim() || 'Super Admin';
    user = await prisma.user.create({ data: { name, phone, role: 'SUPER_ADMIN' } });
    console.log(`Created Super Admin account for ${phone}.`);
  }
  if (!user || !user.isActive) {
    console.error(`No active account found for ${phone}. To create the Super Admin, add: --create-super-admin "Your Name"`);
    process.exit(1);
  }
  const issued = await issueActivationCode(user.id, { resetPin: true });
  console.log('');
  console.log(`  Account : ${user.name} (${user.role})`);
  console.log(`  Phone   : ${phone}`);
  console.log(`  Code    : ${issued.formatted}`);
  console.log(`  Valid until ${issued.expiresAt.toLocaleString()}`);
  console.log('');
}

main()
  .catch((e) => { console.error(e?.message ?? e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });

import { randomInt } from 'crypto';
import { prisma } from '../config/db';

// No 0/O or 1/I/L, so a code read out loud or from a notice can't be mistyped.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function randomSocietyCode(length = 6): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function normaliseSocietyCode(raw: unknown): string {
  return String(raw ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** A code no other society uses. */
export async function uniqueSocietyCode(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = randomSocietyCode();
    const taken = await prisma.society.findUnique({ where: { code } });
    if (!taken) return code;
  }
  throw new Error('Could not generate a society code');
}

/** Ensures a society has a code (older societies created before codes existed). */
export async function ensureSocietyCode(societyId: string): Promise<string> {
  const s = await prisma.society.findUnique({ where: { id: societyId }, select: { code: true } });
  if (s?.code) return s.code;
  const code = await uniqueSocietyCode();
  await prisma.society.update({ where: { id: societyId }, data: { code } });
  return code;
}

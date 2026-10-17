import { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';

// Login brute-force protection. Failed attempts only (skipSuccessfulRequests),
// so a resident who logs in correctly is never penalised. In-memory store is
// fine while the API runs as a single instance; move to a Redis store if the
// API is ever scaled to multiple instances.

const FIFTEEN_MIN = 15 * 60 * 1000;

function tooMany(message: string) {
  return (_req: Request, res: Response) =>
    res.status(429).json({ success: false, message });
}

function cleanPhone(req: Request): string {
  return String(req.body?.phone || '').replace(/[^0-9]/g, '');
}

// 5 wrong codes per phone number (per IP) per 15 minutes.
export const verifyOtpPhoneLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${req.ip}:${cleanPhone(req)}`,
  handler: tooMany('Too many wrong attempts. Please try again in 15 minutes.'),
});

// Wider net: 30 wrong codes per IP per 15 minutes (stops one device sweeping many numbers).
export const verifyOtpIpLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: tooMany('Too many attempts from this device. Please try again later.'),
});

// "Which screen should I show for this number?" lookups: 60 per IP per 15 minutes.
export const checkPhoneLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: tooMany('Too many attempts. Please try again in a few minutes.'),
});

// PIN / activation-code attempts reuse the per-phone and per-IP failure limiters above
// (5 wrong tries per phone+IP, 30 per IP, per 15 minutes). On top of those, the
// account itself locks for 15 minutes after 5 wrong tries, wherever they come from.
export const pinPhoneLimiter = verifyOtpPhoneLimiter;
export const pinIpLimiter = verifyOtpIpLimiter;

// Legacy: OTP "send" requests: 5 per hour per phone (no longer routed).
export const sendOtpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${cleanPhone(req)}`,
  handler: tooMany('Too many requests. Please try again in an hour.'),
});

// Guard PIN is only 4 digits, so it gets the strictest lock:
// 5 wrong PINs per wing + IP per 15 minutes.
export const guardLoginLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${req.ip}:${String(req.body?.wing_code || '').trim().toLowerCase()}`,
  handler: tooMany('Too many wrong attempts. Please try again in 15 minutes.'),
});

export const guardLoginIpLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: tooMany('Too many attempts from this device. Please try again later.'),
});

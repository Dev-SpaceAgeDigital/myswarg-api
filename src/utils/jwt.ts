import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface JwtPayload {
  user_id: string;
  role: string;
  society_id: string;
  wing_id: string;
  flat_id: string | null;
  is_primary?: boolean;
  name?: string;
  society_name?: string;
  // Login session id — only the most recent login for a user is accepted.
  sid?: string;
  // Added by jsonwebtoken when the token is signed (seconds since epoch).
  iat?: number;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions);
}

export function signRefreshToken(payload: Pick<JwtPayload, 'user_id'>): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.REFRESH_TOKEN_EXPIRES_IN } as jwt.SignOptions);
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, env.JWT_SECRET) as JwtPayload;
}

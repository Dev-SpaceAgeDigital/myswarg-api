import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Express 4 does not catch errors thrown inside async handlers — a failed
 * database call would leave the request hanging (and can crash the process).
 * Wrap async handlers so any error becomes a clean 500 instead.
 */
export function asyncSafe(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
  label = 'handler',
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch((err: any) => {
      console.error(`[${label}] Unexpected error:`, err?.message ?? err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
      }
    });
  };
}

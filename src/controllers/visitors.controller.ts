import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { ok, created, badRequest, notFound } from '../utils/response';
import { uploadPublicBuffer } from '../services/upload.service';
import { notifyFlat } from '../services/notification.service';

const logVisitorSchema = z.object({
  flat_id: z.string().min(1),
  visitor_name: z.string().min(1),
  purpose: z.string().optional(),
  delivery_handling: z.enum(['CABIN_DROP', 'HELPER_DELIVERY', 'DIRECT_DELIVERY']).optional(),
});

export async function listVisitors(req: Request, res: Response) {
  const where =
    req.user.role === 'RESIDENT'
      ? { wingId: req.user.wing_id, flatId: req.user.flat_id ?? undefined }
      : { wingId: req.user.wing_id };

  const visitors = await prisma.visitor.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return ok(res, visitors);
}

export async function logVisitor(req: Request, res: Response) {
  const parsed = logVisitorSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.errors[0].message);

  const flat = await prisma.flat.findFirst({ where: { id: parsed.data.flat_id, wingId: req.user.wing_id } });
  if (!flat) return notFound(res, 'Flat not found');

  // The photo comes in as a real file upload (see upload.middleware's
  // handleSingleUpload) — previously the mobile app sent the device's local
  // file:// path as a plain string, which only ever worked on the device
  // that took the photo and showed up broken for everyone else.
  let photoUrl: string | undefined;
  const file = req.file as Express.Multer.File | undefined;
  if (file) {
    try {
      const uploaded = await uploadPublicBuffer(file.buffer, 'visitors');
      photoUrl = uploaded.secureUrl;
    } catch (err: any) {
      console.error('[logVisitor] Photo upload failed:', err.message);
    }
  }

  const visitor = await prisma.visitor.create({
    data: {
      wingId: req.user.wing_id,
      flatId: parsed.data.flat_id,
      visitorName: parsed.data.visitor_name,
      photoUrl,
      purpose: parsed.data.purpose,
      deliveryHandling: parsed.data.delivery_handling,
      // The visitor waits at the gate until someone from the flat approves.
      status: 'PENDING',
    },
  });
  notifyFlat({
    flatId: visitor.flatId,
    title: 'Visitor at the gate',
    body: `${visitor.visitorName}${visitor.purpose ? ` (${visitor.purpose})` : ''} is waiting at the gate. Approve or deny entry.`,
    type: 'VISITOR_AT_GATE',
    relatedId: visitor.id,
  });
  return created(res, visitor, 'Visitor logged. Waiting for the resident to approve.');
}

export async function approveVisitor(req: Request, res: Response) {
  const visitor = await prisma.visitor.findFirst({
    where: { id: req.params.id, wingId: req.user.wing_id, flatId: req.user.flat_id ?? undefined },
  });
  if (!visitor) return notFound(res, 'Visitor not found');
  if (visitor.status !== 'PENDING') return badRequest(res, `This visitor was already ${visitor.status.toLowerCase()}.`);

  const updated = await prisma.visitor.update({
    where: { id: req.params.id },
    data: { status: 'APPROVED', approvedBy: req.user.user_id, entryTime: new Date() },
  });
  notifyFlat({
    flatId: updated.flatId,
    title: 'Visitor approved',
    body: `${updated.visitorName} was approved for entry.`,
    type: 'VISITOR_APPROVED',
    relatedId: updated.id,
  });
  return ok(res, updated, 'Visitor approved');
}

export async function denyVisitor(req: Request, res: Response) {
  const visitor = await prisma.visitor.findFirst({
    where: { id: req.params.id, wingId: req.user.wing_id, flatId: req.user.flat_id ?? undefined },
  });
  if (!visitor) return notFound(res, 'Visitor not found');
  if (visitor.status !== 'PENDING') return badRequest(res, `This visitor was already ${visitor.status.toLowerCase()}.`);

  const updated = await prisma.visitor.update({
    where: { id: req.params.id },
    data: { status: 'DENIED', approvedBy: req.user.user_id },
  });
  notifyFlat({
    flatId: updated.flatId,
    title: 'Visitor denied',
    body: `${updated.visitorName} was denied entry.`,
    type: 'VISITOR_DENIED',
    relatedId: updated.id,
  });
  return ok(res, updated, 'Visitor denied');
}

export async function logVisitorExit(req: Request, res: Response) {
  const visitor = await prisma.visitor.findFirst({ where: { id: req.params.id, wingId: req.user.wing_id } });
  if (!visitor) return notFound(res, 'Visitor not found');
  if (visitor.status !== 'APPROVED') return badRequest(res, 'Only an approved visitor can be logged out.');
  if (visitor.exitTime) return badRequest(res, 'Exit was already logged.');

  const updated = await prisma.visitor.update({ where: { id: req.params.id }, data: { exitTime: new Date() } });
  return ok(res, updated, 'Exit logged');
}

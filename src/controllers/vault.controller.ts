import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/db';
import { ok, created, badRequest, notFound } from '../utils/response';
import { uploadPrivateBuffer, getSignedDownloadUrl, deletePrivateFile } from '../services/upload.service';

const DOC_TYPES = ['AADHAAR', 'PAN', 'SALE_DEED', 'RENT_AGREEMENT', 'PROPERTY_TAX', 'OTHER'] as const;

const uploadBodySchema = z.object({
  docType: z.enum(DOC_TYPES),
  notes: z.string().optional(),
});

export async function listVaultDocuments(req: Request, res: Response) {
  try {
    const userId = req.user.user_id;
    const docTypeParam = req.query.docType as string | undefined;
    const docType = docTypeParam && (DOC_TYPES as readonly string[]).includes(docTypeParam) ? docTypeParam : undefined;

    const documents = await prisma.vaultDocument.findMany({
      where: { userId, ...(docType ? { docType: docType as any } : {}) },
      select: {
        id: true, docType: true, fileName: true, mimeType: true, notes: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return ok(res, documents);
  } catch (err: any) {
    console.error('[listVaultDocuments] Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
}

export async function uploadVaultDocument(req: Request, res: Response) {
  const parsed = uploadBodySchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error.errors[0].message);
  if (!req.file) return badRequest(res, 'No file uploaded');

  const userId = req.user.user_id;
  const { docType, notes } = parsed.data;

  try {
    const uploadResult = await uploadPrivateBuffer(req.file.buffer, `vault/${userId}`);

    const doc = await prisma.vaultDocument.create({
      data: {
        userId,
        docType,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        cloudinaryPublicId: uploadResult.publicId,
        resourceType: uploadResult.resourceType,
        format: uploadResult.format,
        notes,
      },
      select: {
        id: true, docType: true, fileName: true, mimeType: true, notes: true, createdAt: true,
      },
    });
    return created(res, doc, 'Document uploaded');
  } catch (err: any) {
    // http_code is set by Cloudinary errors (401 = wrong key/secret, 400 = rejected file, 420 = rate limit)
    console.error('[uploadVaultDocument] Error:', err?.message, '| http_code:', err?.http_code ?? 'n/a',
      '| mime:', req.file?.mimetype, '| size:', req.file?.size);
    return res.status(500).json({ success: false, message: 'Upload failed. Please try again.' });
  }
}

export async function getVaultDocumentUrl(req: Request, res: Response) {
  const { id } = req.params;
  const userId = req.user.user_id;

  const doc = await prisma.vaultDocument.findFirst({ where: { id, userId } });
  if (!doc) return notFound(res, 'Document not found');

  const url = getSignedDownloadUrl(doc.cloudinaryPublicId, doc.resourceType, doc.format);
  return ok(res, { url, fileName: doc.fileName, mimeType: doc.mimeType, expiresInSeconds: 300 });
}

export async function deleteVaultDocument(req: Request, res: Response) {
  const { id } = req.params;
  const userId = req.user.user_id;

  const doc = await prisma.vaultDocument.findFirst({ where: { id, userId } });
  if (!doc) return notFound(res, 'Document not found');

  try {
    await deletePrivateFile(doc.cloudinaryPublicId, doc.resourceType);
  } catch (err: any) {
    console.error('[deleteVaultDocument] Cloudinary delete failed:', err.message);
    // Continue removing the DB record even if the remote file is already gone
  }

  await prisma.vaultDocument.delete({ where: { id } });
  return ok(res, null, 'Document removed');
}

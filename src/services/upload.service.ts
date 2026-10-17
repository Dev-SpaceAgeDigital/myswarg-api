import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env';

cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
});

if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
  console.warn('[upload] Cloudinary variables are missing — photo and document uploads will fail.');
}

export async function uploadImage(filePath: string, folder: string): Promise<string> {
  const result = await cloudinary.uploader.upload(filePath, { folder });
  return result.secure_url;
}

export async function deleteImage(publicId: string): Promise<void> {
  await cloudinary.uploader.destroy(publicId);
}

// ─── Private (signed-access) uploads — used for sensitive documents like the
// Personal Document Vault. Files are stored with type:'private' so no
// permanent public URL ever exists; a fresh short-lived signed URL must be
// generated on every view/download request via getSignedDownloadUrl().

export interface PrivateUploadResult {
  publicId: string;
  resourceType: string;
  format: string | null;
}

export async function uploadPrivateBuffer(
  buffer: Buffer,
  folder: string,
): Promise<PrivateUploadResult> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, type: 'private', resource_type: 'auto' },
      (error, result) => {
        if (error || !result) return reject(error ?? new Error('Cloudinary upload failed'));
        resolve({
          publicId: result.public_id,
          resourceType: result.resource_type,
          format: result.format ?? null,
        });
      },
    );
    stream.end(buffer);
  });
}

export function getSignedDownloadUrl(
  publicId: string,
  resourceType: string,
  format: string | null,
  expiresInSeconds = 300,
): string {
  return cloudinary.utils.private_download_url(publicId, format ?? undefined, {
    resource_type: resourceType,
    type: 'private',
    expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
  });
}

export async function deletePrivateFile(publicId: string, resourceType: string): Promise<void> {
  await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, type: 'private' });
}

// ─── Public buffer uploads — used for content that's meant to be visible to
// everyone once approved (e.g. Resale/Rent Listing photos). Unlike the
// private vault uploads, these get a permanent public secure_url.

export interface PublicUploadResult {
  publicId: string;
  secureUrl: string;
}

export async function uploadPublicBuffer(buffer: Buffer, folder: string): Promise<PublicUploadResult> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image' },
      (error, result) => {
        if (error || !result) return reject(error ?? new Error('Cloudinary upload failed'));
        resolve({ publicId: result.public_id, secureUrl: result.secure_url });
      },
    );
    stream.end(buffer);
  });
}

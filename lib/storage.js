import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { uploadDir } from '../middleware/upload.js';

// Where uploaded media lives. By default, on local disk under public/uploads (served by
// express.static). With S3_BUCKET set, in an S3-compatible bucket (postfalcon.co uses
// Backblaze B2; AWS S3, Cloudflare R2, Wasabi etc. work too): multer still stages each upload on local disk,
// storeUploadedFile() moves it to the bucket, and routes/uploads.js streams it back. Media
// URLs stay BASE_URL/uploads/<name> either way, so stored post_media rows, and platforms that
// fetch media by URL (Instagram, Threads, Pinterest), work unchanged, and the bucket can stay
// private. Files still on local disk from before S3 was turned on keep working: every read/
// copy/delete checks local disk first, and they age out via the media cleanup job.

export function s3Enabled() {
  return Boolean(process.env.S3_BUCKET);
}

// Backblaze B2's S3 endpoint carries its region (s3.us-west-004.backblazeb2.com), and B2
// rejects requests signed for any other one, so S3_REGION can be left unset there.
function region() {
  if (process.env.S3_REGION) return process.env.S3_REGION;
  const b2 = /^https?:\/\/s3\.([a-z0-9-]+)\.backblazeb2\.com/.exec(process.env.S3_ENDPOINT || '');
  return b2 ? b2[1] : 'auto';
}

// For the privacy policy's "who we share it with" list (app.locals.storageProvider).
export function storageProviderName() {
  if (!s3Enabled()) return null;
  const endpoint = process.env.S3_ENDPOINT || '';
  if (endpoint.includes('backblazeb2.com')) return 'Backblaze B2';
  if (endpoint.includes('r2.cloudflarestorage.com')) return 'Cloudflare R2';
  if (!endpoint || endpoint.includes('amazonaws.com')) return 'Amazon S3';
  return null;
}

let s3Promise;
// Lazy, like getStripe(): the SDK only loads when a bucket is actually configured.
async function s3() {
  s3Promise ??= import('@aws-sdk/client-s3').then((sdk) => ({
    sdk,
    client: new sdk.S3Client({
      region: region(),
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      // SDK versions from early 2025 on add CRC32 checksum headers to every upload by default,
      // which Backblaze B2 and other S3-compatible stores don't all accept. Only send them when
      // an operation actually requires one.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
    }),
  }));
  return s3Promise;
}

// Every bucket failure surfaces as this, with a message fit to show the user (the composer's
// toast, or a failed post's error_message) instead of the S3 error text. Also keeps S3 error
// names like InvalidToken/ExpiredToken out of failed posts, where lib/reconnect.js would
// mistake them for the social platform rejecting the account. app.js answers it with a 503.
export class StorageError extends Error {
  constructor(cause) {
    const capped = /cap exceeded/i.test(String(cause?.message));
    super(
      capped
        ? "Media storage has reached today's free usage limit. Try again tomorrow."
        : 'Media storage is temporarily unavailable. Please try again in a few minutes.',
      { cause }
    );
    this.name = 'StorageError';
    this.code = 'storage_unavailable';
    this.httpStatus = cause?.$metadata?.httpStatusCode;
  }
}

async function send(command) {
  const { client } = await s3();
  try {
    return await client.send(command);
  } catch (err) {
    throw new StorageError(err);
  }
}

function objectKey(name) {
  return `uploads/${name}`;
}

function localPath(name) {
  return path.join(uploadDir, path.basename(name));
}

async function existsLocally(name) {
  return fs.access(localPath(name)).then(
    () => true,
    () => false
  );
}

export function mediaUrl(name) {
  return `${process.env.BASE_URL}/uploads/${name}`;
}

// Same rule multer's filename() and every copy follows: a UUID plus the lowercased extension.
export function isMediaName(name) {
  return /^[0-9a-f-]{36}\.[a-z0-9]{1,10}$/.test(name);
}

async function putFromDisk(name, filePath, contentType) {
  await putFileAtKey(objectKey(name), filePath, contentType);
}

async function putFileAtKey(key, filePath, contentType) {
  const { sdk } = await s3();
  const { size } = await fs.stat(filePath);
  const body = createReadStream(filePath);
  // If the upload is refused before the stream is read, the caller then deletes the staged
  // file, and the still-opening stream would emit ENOENT with no listener: an uncaught
  // exception that takes the whole process down. Read errors already surface through send().
  body.on('error', () => {});
  try {
    await send(
      new sdk.PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: body,
        ContentLength: size,
        ContentType: contentType,
      })
    );
  } finally {
    body.destroy();
  }
}

// Called with a request's multer files once the request is accepted. A no-op without S3.
// All or nothing: if any file fails to upload, the ones that made it are removed again and
// every staged local copy is deleted, so a rejected post leaves nothing behind.
export async function storeUploadedFiles(files) {
  if (!s3Enabled() || files.length === 0) return;
  const results = await Promise.allSettled(files.map((f) => putFromDisk(f.filename, f.path, f.mimetype)));
  await Promise.all(files.map((f) => fs.unlink(f.path).catch(() => {})));
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) {
    await Promise.all(files.map((f, i) => (results[i].status === 'fulfilled' ? deleteMedia(f.filename) : null)));
    throw failed.reason;
  }
}

// Stores bytes generated server-side (e.g. lib/imageFit.js's Instagram-ready copy of a photo)
// under `name`, reachable at mediaUrl(name) like any upload.
export async function saveMedia(name, buffer, contentType) {
  if (!s3Enabled()) {
    await fs.writeFile(localPath(name), buffer);
    return;
  }
  const { sdk } = await s3();
  await send(
    new sdk.PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: objectKey(name),
      Body: buffer,
      ContentLength: buffer.length,
      ContentType: contentType,
    })
  );
}

export async function readMedia(name) {
  if (!s3Enabled() || (await existsLocally(name))) {
    return fs.readFile(localPath(name));
  }
  const { sdk } = await s3();
  const res = await send(new sdk.GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: objectKey(name) }));
  try {
    return Buffer.from(await res.Body.transformToByteArray());
  } catch (err) {
    throw new StorageError(err);
  }
}

// Duplicates a media file under a fresh name (cross-posts and recurring posts each get their
// own copy, so cleaning up one post's media never deletes a file another still uses).
export async function copyMedia(name) {
  const newName = `${crypto.randomUUID()}${path.extname(name)}`;
  if (!s3Enabled()) {
    await fs.copyFile(localPath(name), localPath(newName));
  } else if (await existsLocally(name)) {
    await putFromDisk(newName, localPath(name));
  } else {
    const { sdk } = await s3();
    await send(
      new sdk.CopyObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: objectKey(newName),
        CopySource: encodeURI(`${process.env.S3_BUCKET}/${objectKey(name)}`),
      })
    );
  }
  return newName;
}

// Best effort, like the fs.unlink() calls it replaced: a missing file is not an error.
export async function deleteMedia(name) {
  await fs.unlink(localPath(name)).catch(() => {});
  if (!s3Enabled()) return;
  const { sdk } = await s3();
  await send(new sdk.DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: objectKey(name) })).catch(() => {});
}

// Database backups (lib/backup.js) go to the same bucket under backups/, a prefix routes/uploads.js
// never serves (it only maps /uploads/<uuid>.<ext> to uploads/), so they're never public.
export async function uploadBackup(name, filePath) {
  await putFileAtKey(`backups/${path.basename(name)}`, filePath, 'application/octet-stream');
}

// One backup's bucket copy, when an admin deletes that backup (Admin -> Overview -> Backups).
export async function deleteBucketBackup(name) {
  const { sdk } = await s3();
  await send(new sdk.DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: `backups/${path.basename(name)}` }));
}

// Deletes bucket backups older than `keepDays`. Returns how many were removed.
export async function pruneBucketBackups(keepDays) {
  const { sdk } = await s3();
  const cutoff = Date.now() - keepDays * 86400000;
  let removed = 0;
  let ContinuationToken;
  do {
    const page = await send(new sdk.ListObjectsV2Command({ Bucket: process.env.S3_BUCKET, Prefix: 'backups/', ContinuationToken }));
    for (const object of page.Contents ?? []) {
      if (object.LastModified && object.LastModified.getTime() < cutoff) {
        await send(new sdk.DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: object.Key }));
        removed++;
      }
    }
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return removed;
}

// For the admin overview: how much media is stored, on local disk and (if configured) in the
// bucket. Listing the bucket costs Class C transactions (Backblaze's free tier allows 2,500 a
// day, at 1,000 objects per call), so the bucket total is cached for an hour.
const BUCKET_USAGE_CACHE_MS = 60 * 60 * 1000;
let bucketUsageCache = null;

async function localUsage() {
  const names = await fs.readdir(uploadDir).catch(() => []);
  let bytes = 0;
  let files = 0;
  for (const name of names) {
    const stat = await fs.stat(localPath(name)).catch(() => null);
    if (stat?.isFile()) {
      bytes += stat.size;
      files++;
    }
  }
  return { files, bytes };
}

async function bucketUsage() {
  if (bucketUsageCache && Date.now() - bucketUsageCache.at < BUCKET_USAGE_CACHE_MS) return bucketUsageCache.value;
  const { sdk } = await s3();
  let files = 0;
  let bytes = 0;
  let ContinuationToken;
  do {
    const page = await send(
      new sdk.ListObjectsV2Command({ Bucket: process.env.S3_BUCKET, Prefix: 'uploads/', ContinuationToken })
    );
    for (const object of page.Contents ?? []) {
      files++;
      bytes += object.Size ?? 0;
    }
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  const value = { files, bytes, checkedAt: new Date() };
  bucketUsageCache = { at: Date.now(), value };
  return value;
}

export async function mediaUsage() {
  return {
    local: await localUsage(),
    bucket: s3Enabled() ? await bucketUsage() : null,
  };
}

// For routes/uploads.js: the object's body stream plus the headers to pass through. `range`
// is the request's Range header (video players and Meta's fetchers use it). Resolves null if
// the object doesn't exist.
export async function getMediaObject(name, range) {
  const { sdk } = await s3();
  try {
    return await send(new sdk.GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: objectKey(name), Range: range }));
  } catch (err) {
    if (err.cause?.name === 'NoSuchKey' || err.httpStatus === 404) return null;
    throw err;
  }
}

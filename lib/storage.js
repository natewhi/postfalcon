import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { uploadDir } from '../middleware/upload.js';

// Where uploaded media lives. By default, on local disk under public/uploads (served by
// express.static). With S3_BUCKET set, in any S3-compatible bucket (AWS S3, Cloudflare R2,
// Backblaze B2, Hetzner, Wasabi, ...): multer still stages each upload on local disk,
// storeUploadedFile() moves it to the bucket, and routes/uploads.js streams it back. Media
// URLs stay BASE_URL/uploads/<name> either way, so stored post_media rows, and platforms that
// fetch media by URL (Instagram, Threads, Pinterest), work unchanged, and the bucket can stay
// private. Files still on local disk from before S3 was turned on keep working: every read/
// copy/delete checks local disk first, and they age out via the media cleanup job.

export function s3Enabled() {
  return Boolean(process.env.S3_BUCKET);
}

let s3Promise;
// Lazy, like getStripe(): the SDK only loads when a bucket is actually configured.
async function s3() {
  s3Promise ??= import('@aws-sdk/client-s3').then((sdk) => ({
    sdk,
    client: new sdk.S3Client({
      region: process.env.S3_REGION || 'auto',
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
    }),
  }));
  return s3Promise;
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
  const { sdk, client } = await s3();
  const { size } = await fs.stat(filePath);
  await client.send(
    new sdk.PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: objectKey(name),
      Body: createReadStream(filePath),
      ContentLength: size,
      ContentType: contentType,
    })
  );
}

// Called on each multer file once the request is accepted. A no-op without S3.
export async function storeUploadedFile(file) {
  if (!s3Enabled()) return;
  await putFromDisk(file.filename, file.path, file.mimetype);
  await fs.unlink(file.path).catch(() => {});
}

export async function readMedia(name) {
  if (!s3Enabled() || (await existsLocally(name))) {
    return fs.readFile(localPath(name));
  }
  const { sdk, client } = await s3();
  const res = await client.send(new sdk.GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: objectKey(name) }));
  return Buffer.from(await res.Body.transformToByteArray());
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
    const { sdk, client } = await s3();
    await client.send(
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
  const { sdk, client } = await s3();
  await client
    .send(new sdk.DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: objectKey(name) }))
    .catch(() => {});
}

// For routes/uploads.js: the object's body stream plus the headers to pass through. `range`
// is the request's Range header (video players and Meta's fetchers use it). Resolves null if
// the object doesn't exist.
export async function getMediaObject(name, range) {
  const { sdk, client } = await s3();
  try {
    return await client.send(
      new sdk.GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: objectKey(name), Range: range })
    );
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

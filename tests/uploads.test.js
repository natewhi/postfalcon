import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import app from '../app.js';
import { uploadDir } from '../middleware/upload.js';
import { copyMedia, readMedia } from '../lib/storage.js';
import { looksLikeAuthFailure } from '../lib/reconnect.js';
import { pool } from '../db/pool.js';

function s3Error(name, message, httpStatusCode) {
  return Object.assign(new Error(message), { name, $metadata: { httpStatusCode } });
}

// An in-memory stand-in for an S3 bucket: key -> { body, contentType }.
// `outage`, when set, is the S3 error every request fails with.
const { bucket, fake } = vi.hoisted(() => ({ bucket: new Map(), fake: { outage: null } }));

vi.mock('@aws-sdk/client-s3', async () => {
  const { Readable } = await import('node:stream');
  class Command {
    constructor(input) {
      this.input = input;
    }
  }
  class PutObjectCommand extends Command {}
  class GetObjectCommand extends Command {}
  class CopyObjectCommand extends Command {}
  class DeleteObjectCommand extends Command {}
  const notFound = () => Object.assign(new Error('not found'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });

  class S3Client {
    async send(cmd) {
      if (fake.outage) throw fake.outage;
      const { Key } = cmd.input;
      if (cmd instanceof PutObjectCommand) {
        const chunks = [];
        for await (const chunk of cmd.input.Body) chunks.push(chunk);
        bucket.set(Key, { body: Buffer.concat(chunks), contentType: cmd.input.ContentType });
        return {};
      }
      if (cmd instanceof CopyObjectCommand) {
        const sourceKey = decodeURI(cmd.input.CopySource).replace(`${cmd.input.Bucket}/`, '');
        if (!bucket.has(sourceKey)) throw notFound();
        bucket.set(Key, { ...bucket.get(sourceKey) });
        return {};
      }
      if (cmd instanceof DeleteObjectCommand) {
        bucket.delete(Key);
        return {};
      }
      const obj = bucket.get(Key);
      if (!obj) throw notFound();
      let body = obj.body;
      let ContentRange;
      const match = /^bytes=(\d+)-(\d*)$/.exec(cmd.input.Range || '');
      if (match) {
        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : obj.body.length - 1;
        body = obj.body.subarray(start, end + 1);
        ContentRange = `bytes ${start}-${end}/${obj.body.length}`;
      }
      const stream = Readable.from([body]);
      stream.transformToByteArray = async () => new Uint8Array(body);
      return { Body: stream, ContentType: obj.contentType, ContentLength: body.length, ContentRange };
    }
  }
  return { S3Client, PutObjectCommand, GetObjectCommand, CopyObjectCommand, DeleteObjectCommand };
});

async function loginNewUser() {
  const client = request.agent(app);
  const email = `user${Date.now()}${Math.random()}@example.com`;
  await client.post('/api/users').send({ email, password: 'password123' });
  await client.post('/api/auth/login').send({ email, password: 'password123' });
  return client;
}

async function postWithImage(client, bytes) {
  const account = await client.post('/api/v1/social-accounts').send({ platform: 'twitter', display_name: '@me' });
  return client
    .post('/api/v1/posts')
    .field('social_account_id', String(account.body.id))
    .field('content', 'post with image')
    .attach('media', Buffer.from(bytes), { filename: 'photo.jpg', contentType: 'image/jpeg' });
}

describe('uploads in an S3 bucket', () => {
  beforeAll(() => {
    process.env.S3_BUCKET = 'test-bucket';
  });
  afterAll(() => {
    delete process.env.S3_BUCKET;
  });

  it('moves an uploaded file into the bucket and serves it back at the same /uploads URL', async () => {
    const client = await loginNewUser();
    const post = await postWithImage(client, 'fake-image-bytes');
    expect(post.status).toBe(201);

    const name = path.basename(post.body.media[0].url);
    expect(bucket.get(`uploads/${name}`).body.toString()).toBe('fake-image-bytes');
    expect(fs.existsSync(path.join(uploadDir, name))).toBe(false);

    const res = await request(app).get(`/uploads/${name}`).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.body.toString()).toBe('fake-image-bytes');
  });

  it('honours Range requests', async () => {
    const client = await loginNewUser();
    const post = await postWithImage(client, '0123456789');
    const name = path.basename(post.body.media[0].url);

    const res = await request(app).get(`/uploads/${name}`).set('Range', 'bytes=2-5');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 2-5/10');
    expect(res.headers['content-length']).toBe('4');
  });

  it('404s for a file that is in neither the bucket nor on disk', async () => {
    const res = await request(app).get('/uploads/00000000-0000-0000-0000-000000000000.jpg');
    expect(res.status).toBe(404);
  });

  it('deletes the object when its post is deleted', async () => {
    const client = await loginNewUser();
    const post = await postWithImage(client, 'to-be-deleted');
    const name = path.basename(post.body.media[0].url);
    expect(bucket.has(`uploads/${name}`)).toBe(true);

    await client.delete(`/api/v1/posts/${post.body.id}`).expect(204);
    expect(bucket.has(`uploads/${name}`)).toBe(false);
  });

  it('copies and reads media in the bucket, and still reads files left on local disk', async () => {
    bucket.set('uploads/11111111-1111-1111-1111-111111111111.png', { body: Buffer.from('in-bucket') });
    const copy = await copyMedia('11111111-1111-1111-1111-111111111111.png');
    expect(copy).toMatch(/\.png$/);
    expect((await readMedia(copy)).toString()).toBe('in-bucket');

    const legacy = '22222222-2222-2222-2222-222222222222.png';
    fs.writeFileSync(path.join(uploadDir, legacy), 'on-disk');
    expect((await readMedia(legacy)).toString()).toBe('on-disk');
    fs.unlinkSync(path.join(uploadDir, legacy));
  });

  describe('when the bucket fails', () => {
    afterAll(() => {
      fake.outage = null;
    });

    it('rejects the post with a readable 503 and leaves no files or rows behind', async () => {
      const client = await loginNewUser();
      const before = fs.readdirSync(uploadDir).length;
      fake.outage = s3Error('InvalidAccessKeyId', "The key '005abc' is not valid", 403);

      const post = await postWithImage(client, 'never-stored');
      expect(post.status).toBe(503);
      expect(post.body).toEqual({
        error: 'storage_unavailable',
        message: 'Media storage is temporarily unavailable. Please try again in a few minutes.',
      });
      expect(fs.readdirSync(uploadDir).length).toBe(before);
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM posts');
      expect(rows[0].n).toBe(0);
    });

    it("says so when Backblaze's daily cap is hit", async () => {
      fake.outage = s3Error(
        'AccessDenied',
        'Cannot download file, download bandwidth or transaction (Class B) cap exceeded.',
        403
      );
      await expect(readMedia('33333333-3333-3333-3333-333333333333.mp4')).rejects.toThrow(
        "Media storage has reached today's free usage limit. Try again tomorrow."
      );
    });

    it("isn't mistaken for the social platform rejecting the account", async () => {
      fake.outage = s3Error('ExpiredToken', 'The provided token has expired.', 400);
      const err = await readMedia('44444444-4444-4444-4444-444444444444.mp4').catch((e) => e);
      expect(err.code).toBe('storage_unavailable');
      expect(looksLikeAuthFailure(err)).toBe(false);
    });
  });
});

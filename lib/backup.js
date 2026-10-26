import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { s3Enabled, uploadBackup, pruneBucketBackups, deleteBucketBackup } from './storage.js';

// Nightly database backup (scheduler.js) and `npm run backup` (scripts/backup.js). Runs pg_dump
// in its compressed custom format into BACKUP_DIR (default <app>/backups, git-ignored), keeps
// the last LOCAL_KEEP there, and when a bucket is configured also uploads it under backups/
// (kept BUCKET_KEEP_DAYS) — so losing the server's disk doesn't lose the only copy.
//
// Restore (stop the app first):  pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" <file>.dump

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_KEEP = 7;
const BUCKET_KEEP_DAYS = 30;

export function backupDir() {
  return process.env.BACKUP_DIR || path.join(__dirname, '../backups');
}

// pg_dump reads the connection from PG* env vars rather than a URL argument, so the password
// isn't visible in the process list.
function pgEnv() {
  const url = new URL(process.env.DATABASE_URL);
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: url.pathname.replace(/^\//, ''),
  };
}

function runPgDump(file) {
  return new Promise((resolve, reject) => {
    const child = spawn('pg_dump', ['--format=custom', '--no-owner', `--file=${file}`], { env: pgEnv() });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => reject(new Error(`could not run pg_dump: ${err.message}`)));
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`pg_dump exited with ${code}: ${stderr.trim().slice(0, 500)}`))
    );
  });
}

export async function listLocalBackups() {
  const dir = backupDir();
  const names = (await fs.readdir(dir).catch(() => [])).filter((n) => n.endsWith('.dump'));
  const entries = await Promise.all(
    names.map(async (name) => {
      const stat = await fs.stat(path.join(dir, name)).catch(() => null);
      return stat ? { name, bytes: stat.size, at: stat.mtime } : null;
    })
  );
  return entries.filter(Boolean).sort((a, b) => b.at - a.at);
}

export async function runBackup() {
  const dir = backupDir();
  await fs.mkdir(dir, { recursive: true });
  const name = `postfalcon-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`;
  const file = path.join(dir, name);
  try {
    await runPgDump(file);
  } catch (err) {
    await fs.unlink(file).catch(() => {});
    throw err;
  }
  const { size } = await fs.stat(file);

  let uploaded = false;
  let bucketPruned = 0;
  if (s3Enabled()) {
    await uploadBackup(name, file);
    uploaded = true;
    bucketPruned = await pruneBucketBackups(BUCKET_KEEP_DAYS);
  }

  const old = (await listLocalBackups()).slice(LOCAL_KEEP);
  await Promise.all(old.map((b) => fs.unlink(path.join(dir, b.name)).catch(() => {})));

  return { name, bytes: size, uploaded, localPruned: old.length, bucketPruned };
}

// Deletes one backup by name, from this server and from the bucket when there is one (Admin ->
// Overview -> Backups). Only a file the listing knows about, so a name can't reach outside the
// backup folder. Returns null for an unknown name, else whether the bucket copy went too (false
// when there's no bucket, or it couldn't be reached: that copy then expires on its own).
export async function deleteBackup(name) {
  const backup = (await listLocalBackups()).find((b) => b.name === name);
  if (!backup) return null;
  await fs.unlink(path.join(backupDir(), backup.name));
  let bucketDeleted = false;
  if (s3Enabled()) {
    bucketDeleted = await deleteBucketBackup(backup.name).then(
      () => true,
      () => false
    );
  }
  return { name: backup.name, bucketDeleted };
}

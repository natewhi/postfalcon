import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db/pool.js';
import { isConfigured } from './config.js';

// Overview -> Version: which commit this server runs, how far behind the project's GitHub main
// it is, and whether every database migration is applied. The commit is read straight from
// .git's files (no git binary needed, which the Docker image doesn't have; .dockerignore lets
// just those files through), or from APP_COMMIT when set.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const UPDATE_CACHE_MS = 6 * 3600000;
// A failed check is retried sooner than a successful one is refreshed.
const FAILED_CACHE_MS = 10 * 60000;
const GITHUB_TIMEOUT_MS = 5000;

// Where updates come from. UPDATE_CHECK_REPO points a fork at itself; UPDATE_CHECK=false turns
// the check (one GitHub API call per 6 hours, made only when an admin opens Overview) off.
export function upstreamRepo() {
  return isConfigured(process.env.UPDATE_CHECK_REPO) ? process.env.UPDATE_CHECK_REPO.trim() : 'natewhi/postfalcon';
}

export async function runningCommit() {
  if (isConfigured(process.env.APP_COMMIT)) return process.env.APP_COMMIT.trim();
  const gitDir = path.join(ROOT, '.git');
  try {
    const head = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
    if (!head.startsWith('ref: ')) return /^[0-9a-f]{40}$/.test(head) ? head : null;
    const ref = head.slice(5);
    const loose = await fs.readFile(path.join(gitDir, ref), 'utf8').catch(() => null);
    if (loose) return loose.trim();
    const packed = await fs.readFile(path.join(gitDir, 'packed-refs'), 'utf8').catch(() => '');
    const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
    return line ? line.split(' ')[0] : null;
  } catch {
    return null;
  }
}

export async function pendingMigrations() {
  const files = (await fs.readdir(path.join(ROOT, 'db', 'migrations'))).filter((f) => f.endsWith('.sql'));
  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));
  return files.filter((f) => !applied.has(f)).sort();
}

let cached = null;

// { latestCommit, latestDate, behindBy } from GitHub, or { error }. Cached for 6 hours.
async function upstreamStatus(commit) {
  if (process.env.UPDATE_CHECK === 'false') return { disabled: true };
  if (cached && cached.commit === commit && Date.now() - cached.at < (cached.result.error ? FAILED_CACHE_MS : UPDATE_CACHE_MS)) {
    return cached.result;
  }
  const repo = upstreamRepo();
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'postfalcon-update-check' };
  let result;
  try {
    const latestRes = await fetch(`https://api.github.com/repos/${repo}/commits/main`, {
      headers,
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!latestRes.ok) throw new Error(`GitHub answered ${latestRes.status}`);
    const latest = await latestRes.json();
    result = { repo, latestCommit: latest.sha, latestDate: latest.commit?.committer?.date ?? null, behindBy: null };
    if (commit && commit !== latest.sha) {
      const compareRes = await fetch(`https://api.github.com/repos/${repo}/compare/${commit}...${latest.sha}`, {
        headers,
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
      // A commit GitHub doesn't know (local changes, a fork) just leaves behindBy unknown.
      if (compareRes.ok) result.behindBy = (await compareRes.json()).ahead_by ?? null;
    } else if (commit) {
      result.behindBy = 0;
    }
  } catch (err) {
    result = { repo, error: err.message };
  }
  cached = { commit, at: Date.now(), result };
  return result;
}

export function clearUpdateCache() {
  cached = null;
}

export async function versionStatus() {
  const commit = await runningCommit();
  const [pending, upstream] = await Promise.all([pendingMigrations(), upstreamStatus(commit)]);
  return { commit, pendingMigrations: pending, upstream };
}

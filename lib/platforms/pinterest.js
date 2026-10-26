// Pinterest Pins are inherently image/video objects — there's no text-only Pin type, so unlike
// every other adapter here a Pin always needs media. The image just needs to be a public URL
// (uploaded media already is one — BASE_URL/uploads/<file>), so no upload dance is needed, only
// a single API call. Video pins need Pinterest's separate media-upload flow — not built yet.
// Pins always post to one board, stored in social_accounts.metadata (same place Mastodon stores
// its instance domain): the account's first board at connect time, changeable on the Accounts
// page (routes/pinterest.js). If Pinterest refuses that board, publish() moves on to one that
// works rather than failing the post — see pinToAnotherBoard().
import { pool } from '../../db/pool.js';
import { logger } from '../logger.js';
import { refreshedAccessToken } from './oauthRefresh.js';

const TOKEN_URL = 'https://api.pinterest.com/v5/oauth/token';

// Where boards and Pins are written. An app on Pinterest's Trial access tier may not create
// Pins in production, only in the API sandbox (PINTEREST_API_BASE=https://api-sandbox.pinterest.com),
// which is also where Pinterest expects the Standard-access demo to be recorded. Boards made in
// the sandbox still show up in the live API's board list for the same account, with nothing
// marking them as sandbox, and the live API refuses Pins on them ("Cannot add non-sandbox pins
// on sandbox boards"); publish() steps around those (and remembers them) on its own.
export function pinterestApiBase() {
  return (process.env.PINTEREST_API_BASE || 'https://api.pinterest.com').replace(/\/+$/, '');
}

// The sandbox doesn't accept OAuth tokens from the normal connect flow (401). It only takes a
// token generated for the developer's own account under My apps -> Manage in Pinterest's
// developer portal. When PINTEREST_SANDBOX_TOKEN is set, board and Pin calls use it instead of
// the connected account's token, so every Pin lands in that one developer sandbox. It exists
// for recording the Standard-access demo, never for real users; unset it after the upgrade.
export function sandboxToken() {
  return process.env.PINTEREST_SANDBOX_TOKEN?.trim() || null;
}

// Pinterest authenticates the app with HTTP Basic auth on its token endpoint, not with client
// credentials in the body. Shared with routes/pinterest.js's code exchange.
export function basicAuthHeader() {
  return `Basic ${Buffer.from(`${process.env.PINTEREST_APP_ID}:${process.env.PINTEREST_APP_SECRET}`).toString('base64')}`;
}

// Pinterest access tokens last 30 days; the refresh token (stored since the connect flow asked
// for it) renews them. An account with no expiry on file predates that, so its token is used
// as-is until Pinterest rejects it and the account gets flagged for reconnect.
export function accessToken(post) {
  if (!post.token_expires_at) return post.access_token;
  return refreshedAccessToken(post, {
    tokenUrl: TOKEN_URL,
    headers: { Authorization: basicAuthHeader() },
    form: { grant_type: 'refresh_token', refresh_token: post.refresh_token },
  });
}

// Pinterest's answer when the board itself is the problem: a sandbox board (see above), or one
// deleted, archived or no longer shared with the account since it was chosen. Anything else (a
// bad image, an expired token, a rate limit) isn't fixed by trying another board.
function isBoardRejection(status, data) {
  return [400, 403, 404].includes(status) && /board/i.test(String(data?.message ?? ''));
}

// Boards tried per publish before giving up on the account's existing ones and making a new one.
const MAX_BOARD_ATTEMPTS = 10;

export async function listBoards(token) {
  const res = await fetch(`${pinterestApiBase()}/v5/boards?page_size=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Pinterest boards lookup failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return (data.items || []).map((b) => ({ id: String(b.id), name: b.name, privacy: b.privacy ?? null }));
}

async function createPin(token, boardId, post, image) {
  const res = await fetch(`${pinterestApiBase()}/v5/pins`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      board_id: boardId,
      description: post.content,
      media_source: { source_type: 'image_url', url: image.url },
    }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function pinError({ status, data }) {
  return new Error(`Pinterest pin failed (${status}): ${JSON.stringify(data)}`);
}

// Saves the board that just took a Pin as the account's board, plus every board Pinterest
// refused on the way, so the Accounts page can label them and later posts skip them.
async function rememberBoard(post, board, unusable) {
  const metadata = {
    ...(post.metadata || {}),
    board_id: board.id,
    board_name: board.name,
    unusable_board_ids: [...unusable],
  };
  await pool.query('UPDATE social_accounts SET metadata = $1 WHERE id = $2', [metadata, post.social_account_id]);
  post.metadata = metadata;
  logger.warn(
    { socialAccountId: post.social_account_id, boardId: board.id, skipped: [...unusable] },
    'pinterest board refused pins, switched the account to another board'
  );
}

async function createBoard(token, existing) {
  const taken = new Set(existing.map((b) => String(b.name).toLowerCase()));
  const name = ['Postfalcon', 'Postfalcon Pins'].find((n) => !taken.has(n.toLowerCase())) || `Postfalcon ${Date.now()}`;
  const res = await fetch(`${pinterestApiBase()}/v5/boards`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description: 'Pins published with Postfalcon', privacy: 'PUBLIC' }),
  });
  const data = await res.json().catch(() => null);
  return res.ok && data?.id ? { id: String(data.id), name: data.name || name } : null;
}

// The saved board was refused: try the account's other boards, then a newly created one (a
// board made through the API Postfalcon is pointed at always accepts its Pins), and keep
// whichever works. Only when none does is the post failed, with the original reason.
async function pinToAnotherBoard(post, token, image, firstFailure) {
  const unusable = new Set([...(post.metadata?.unusable_board_ids || []), String(post.metadata.board_id)]);
  const boards = await listBoards(token).catch((err) => {
    logger.warn({ err, socialAccountId: post.social_account_id }, 'pinterest boards lookup failed');
    return [];
  });

  for (const board of boards.filter((b) => !unusable.has(b.id)).slice(0, MAX_BOARD_ATTEMPTS)) {
    const attempt = await createPin(token, board.id, post, image);
    if (attempt.ok) {
      await rememberBoard(post, board, unusable);
      return attempt.data.id;
    }
    if (!isBoardRejection(attempt.status, attempt.data)) throw pinError(attempt);
    unusable.add(board.id);
  }

  const created = await createBoard(token, boards);
  if (created) {
    const attempt = await createPin(token, created.id, post, image);
    if (attempt.ok) {
      await rememberBoard(post, created, unusable);
      return attempt.data.id;
    }
    throw pinError(attempt);
  }

  // Hint before the raw response, which the dashboard parses as trailing JSON (readablePostError).
  throw new Error(
    'Pinterest pin failed on every board of this account and a new board could not be created — ' +
      `create a board on pinterest.com, then choose it on the Accounts page (${firstFailure.status}): ` +
      JSON.stringify(firstFailure.data)
  );
}

export async function publish(post) {
  const media = post.media || [];
  const image = media.find((m) => m.media_type === 'image');
  if (!image) {
    throw new Error('Pinterest pins need an image attached — video pins are not supported yet.');
  }

  const boardId = post.metadata?.board_id;
  if (!boardId) {
    throw new Error('This Pinterest account has no board on file — reconnect it.');
  }

  const token = sandboxToken() || (await accessToken(post));
  const attempt = await createPin(token, boardId, post, image);
  if (attempt.ok) return attempt.data.id;
  if (!isBoardRejection(attempt.status, attempt.data)) throw pinError(attempt);
  return pinToAnotherBoard(post, token, image, attempt);
}

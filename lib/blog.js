import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { marked } from 'marked';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// One Markdown file per post, frontmatter + body. No database table and no admin UI on
// purpose — posts are meant to be edited directly (title, copy, and especially `slug`) as
// the site owner iterates on SEO, without going through a form. Re-read from disk on every
// call (no caching): editing a file takes effect on the next request, no restart needed.
export const blogDir = path.join(__dirname, '../content/blog');

// The blog is this site's own marketing content (including posts pitching self-hosting itself),
// not something a self-hoster's instance should carry by default — content/blog/*.md still ships
// in the repo either way (same "just edit the files" model as everything else here), but
// ENABLE_BLOG=false in a self-hoster's .env drops the /blog route, its nav links, and its
// sitemap entries. Unset (or anything but the literal string "false") keeps it on, so the
// original deployment needs no .env change.
export function isBlogEnabled() {
  return process.env.ENABLE_BLOG !== 'false';
}

marked.setOptions({ gfm: true });

const WORDS_PER_MINUTE = 200;
const AUTO_EXCERPT_LENGTH = 160;

// Byline registry — keyed by the frontmatter `author` id. Add more people here as they start
// writing; a post with no `author` (or one that doesn't match a key here) falls back to
// DEFAULT_AUTHOR. `initial` drives the placeholder avatar (a plain letter badge), shown
// whenever no photo is found — see findAuthorAvatar() below for how a photo gets picked up.
export const AUTHORS = {
  nathan: { name: 'Nathan', title: null },
};
export const DEFAULT_AUTHOR = 'nathan';

// Avatar photos are picked up by convention, not configured — drop an image named after the
// author's id (the same key used in AUTHORS/frontmatter `author:`) into this directory and it
// shows up automatically, no code edit needed. Checked in this order; first match wins.
export const authorAvatarDir = path.join(__dirname, '../public/images/authors');
const AVATAR_EXTENSIONS = ['webp', 'jpg', 'jpeg', 'png'];

// Re-checked on every call (no caching), matching the rest of this module — drop a file in,
// refresh the page, see it. A handful of authors × a few extensions is a handful of stat()
// calls, cheap enough not to bother caching.
async function findAuthorAvatar(id) {
  for (const ext of AVATAR_EXTENSIONS) {
    const file = `${id}.${ext}`;
    try {
      await fsp.access(path.join(authorAvatarDir, file));
      return `/images/authors/${file}`;
    } catch {
      // not this extension, try the next
    }
  }
  return null;
}

async function resolveAuthor(id) {
  const author = AUTHORS[id] || AUTHORS[DEFAULT_AUTHOR];
  const resolvedId = AUTHORS[id] ? id : DEFAULT_AUTHOR;
  return { ...author, initial: author.name.charAt(0).toUpperCase(), avatar: await findAuthorAvatar(resolvedId) };
}

function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Rough plain-text version of the Markdown body, for word counts and a fallback excerpt
// when a post has no explicit `description`.
function stripMarkdown(md) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~`-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Card art for the /blog grid. There's no illustration per post (and no AI image-gen wired
// into this app) — so instead of a blank thumbnail, each card gets a small generated graphic:
// a gradient (one of THUMB_PALETTE_COUNT) + a decorative icon (one of THUMB_ICON_COUNT), picked
// deterministically from a hash of the post's slug so it's stable across requests without being
// stored anywhere. Set frontmatter `image:` on a post to use a real picture instead — see
// readPostFile below, where `image` wins over `cardArt` in the view.
export const THUMB_PALETTE_COUNT = 6;
export const THUMB_ICON_COUNT = 4;

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function cardArt(slug) {
  const hash = hashString(slug);
  return {
    palette: (hash % THUMB_PALETTE_COUNT) + 1,
    icon: Math.floor(hash / THUMB_PALETTE_COUNT) % THUMB_ICON_COUNT,
  };
}

const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

// Hero banner background for a post, cheapest to richest: `heroImage` (a background-only SVG —
// same gradient/dot-texture/blobs as the card art's illustration, minus its centerpiece, which
// crops awkwardly at hero height) beats `heroGradient` (two hex colors, rendered as a flat
// linear-gradient) beats the view's own fallback to the deterministic cardArt() gradient any
// imageless post already gets on the /blog grid. See views/blog-post.ejs for the picking order.
function heroGradient(data) {
  if (!Array.isArray(data.heroGradient) || data.heroGradient.length !== 2) return null;
  const colors = data.heroGradient.map((c) => String(c).trim());
  return colors.every((c) => HEX_COLOR.test(c)) ? colors : null;
}

function slugifyHeading(text) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  );
}

// Gives every <h2>/<h3> in the rendered HTML a stable id (for deep links and the "Contents"
// sidebar) and pulls out the <h2>s as a flat table of contents. Done as a post-process over
// the rendered HTML — rather than a marked renderer hook — so it doesn't depend on marked's
// exact renderer callback signature for whichever version ends up installed.
function addHeadingIdsAndToc(html) {
  const used = new Set();
  const toc = [];
  const withIds = html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (match, level, inner) => {
    const plain = inner.replace(/<[^>]+>/g, '').trim();
    let slug = slugifyHeading(plain);
    let unique = slug;
    let n = 2;
    while (used.has(unique)) unique = `${slug}-${n++}`;
    used.add(unique);
    if (level === '2') toc.push({ text: plain, slug: unique });
    return `<h${level} id="${unique}">${inner}</h${level}>`;
  });
  return { html: withIds, toc };
}

// Parses one post file. Returns null (and logs a warning) instead of throwing, so a single
// malformed post can't take down the whole /blog index while it's being edited.
async function readPostFile(filename) {
  try {
    const raw = await fsp.readFile(path.join(blogDir, filename), 'utf8');
    const { data, content } = matter(raw);
    if (!data.slug || !data.title) {
      throw new Error('frontmatter is missing "slug" or "title"');
    }

    const plain = stripMarkdown(content);
    const wordCount = plain ? plain.split(' ').length : 0;
    const { html, toc } = addHeadingIdsAndToc(marked.parse(content));
    const slug = String(data.slug).trim().replace(/^\/+|\/+$/g, '');

    return {
      slug,
      cardArt: cardArt(slug),
      title: String(data.title).trim(),
      description: data.description
        ? String(data.description).trim()
        : `${plain.slice(0, AUTO_EXCERPT_LENGTH).trim()}…`,
      date: toDate(data.date) || new Date(0),
      updated: toDate(data.updated),
      draft: Boolean(data.draft),
      image: data.image ? String(data.image) : null,
      heroImage: data.heroImage ? String(data.heroImage) : null,
      heroGradient: heroGradient(data),
      tags: Array.isArray(data.tags) ? data.tags.map((t) => String(t).trim()).filter(Boolean) : [],
      author: await resolveAuthor(data.author ? String(data.author).trim().toLowerCase() : DEFAULT_AUTHOR),
      // Old slugs that should 301 to this post — set when you rename a slug so any inbound
      // links/search-engine indexing from the old URL still land somewhere.
      redirects: Array.isArray(data.redirects) ? data.redirects.map((s) => String(s).trim()) : [],
      readingTime: Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE)),
      excerpt: plain.slice(0, 220).trim(),
      toc,
      html,
      file: filename,
    };
  } catch (err) {
    logger.warn({ err, file: filename }, 'skipping malformed blog post');
    return null;
  }
}

export async function listPosts({ includeDrafts = false } = {}) {
  let files;
  try {
    files = await fsp.readdir(blogDir);
  } catch {
    return [];
  }

  const posts = (await Promise.all(files.filter((f) => f.endsWith('.md')).map(readPostFile))).filter(Boolean);

  const bySlug = new Map();
  for (const post of posts) {
    const existing = bySlug.get(post.slug);
    if (existing) {
      logger.warn({ slug: post.slug, files: [existing.file, post.file] }, 'duplicate blog slug — keeping the first one');
      continue;
    }
    bySlug.set(post.slug, post);
  }

  return [...bySlug.values()]
    .filter((p) => includeDrafts || !p.draft)
    .sort((a, b) => b.date - a.date);
}

// Unique tags across all (published) posts, in first-seen order, for the "Browse by category"
// pill row — deduped case-insensitively so "guides" and "Guides" in different posts don't show
// as two pills, but the first-seen casing is kept for display.
export function categories(posts) {
  const seen = new Map();
  for (const post of posts) {
    for (const tag of post.tags) {
      const key = tag.toLowerCase();
      if (!seen.has(key)) seen.set(key, tag);
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

export function filterByCategory(posts, category) {
  if (!category) return posts;
  const key = category.toLowerCase();
  return posts.filter((post) => post.tags.some((tag) => tag.toLowerCase() === key));
}

const POSTS_PER_PAGE = 10;

export function paginate(posts, page = 1) {
  const totalPages = Math.max(1, Math.ceil(posts.length / POSTS_PER_PAGE));
  const current = Math.min(Math.max(1, page || 1), totalPages);
  const start = (current - 1) * POSTS_PER_PAGE;
  return {
    items: posts.slice(start, start + POSTS_PER_PAGE),
    page: current,
    totalPages,
    hasPrev: current > 1,
    hasNext: current < totalPages,
  };
}

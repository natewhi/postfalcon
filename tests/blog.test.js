import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import app from '../app.js';
import { blogDir, authorAvatarDir, listPosts, categories, filterByCategory } from '../lib/blog.js';

// Fixture posts are written straight into content/blog/ (the real, uncached content dir —
// lib/blog.js re-reads from disk on every request) with a distinctive prefix so they can
// never collide with real posts, and removed again after each test. This lets edge cases
// (drafts, redirects, malformed frontmatter, duplicate slugs) be tested in isolation without
// depending on — or being broken by — whatever real content currently exists.
const FIXTURE_PREFIX = '__test-fixture-';
const writtenFixtures = [];

async function writeFixture(name, content) {
  const file = `${FIXTURE_PREFIX}${name}.md`;
  await fs.writeFile(path.join(blogDir, file), content, 'utf8');
  writtenFixtures.push(file);
}

const writtenAvatars = [];

afterEach(async () => {
  await Promise.all(writtenFixtures.splice(0).map((f) => fs.unlink(path.join(blogDir, f)).catch(() => {})));
  await Promise.all(writtenAvatars.splice(0).map((f) => fs.unlink(path.join(authorAvatarDir, f)).catch(() => {})));
});

describe('blog', () => {
  it('GET /blog lists posts and returns 200', async () => {
    const res = await request(app).get('/blog');
    expect(res.status).toBe(200);
    expect(res.type).toBe('text/html');
    expect(res.text).toContain('Postfox');
  });

  it('GET /blog?page=999 clamps to the last page instead of erroring', async () => {
    const res = await request(app).get('/blog?page=999');
    expect(res.status).toBe(200);
  });

  it('404s an unknown slug', async () => {
    const res = await request(app).get('/blog/this-slug-does-not-exist-xyz');
    expect(res.status).toBe(404);
  });

  it('renders a real post at its slug, with SEO tags present', async () => {
    const [post] = await listPosts();
    expect(post).toBeTruthy();

    const res = await request(app).get(`/blog/${post.slug}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(post.title);
    expect(res.text).toContain('<link rel="canonical"');
    expect(res.text).toContain('application/ld+json');
    expect(res.text).toContain('og:title');
  });

  it('lists a post written straight to content/blog', async () => {
    await writeFixture(
      'basic',
      ['---', 'title: Fixture Post', 'slug: __test-fixture-basic', 'description: A fixture post.', 'date: 2026-01-01', '---', '', 'Hello from a fixture.'].join('\n')
    );

    const res = await request(app).get(`/blog/__test-fixture-basic`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Fixture Post');
    expect(res.text).toContain('Hello from a fixture.');
  });

  it('does not list or serve a draft post', async () => {
    await writeFixture(
      'draft',
      ['---', 'title: Draft Post', 'slug: __test-fixture-draft', 'description: Not published yet.', 'date: 2026-01-01', 'draft: true', '---', '', 'Shh.'].join('\n')
    );

    const index = await request(app).get('/blog');
    expect(index.text).not.toContain('Draft Post');

    const direct = await request(app).get('/blog/__test-fixture-draft');
    expect(direct.status).toBe(404);
  });

  it('301s an old slug listed under redirects to the new one', async () => {
    await writeFixture(
      'renamed',
      [
        '---',
        'title: Renamed Post',
        'slug: __test-fixture-renamed-new',
        'description: Moved.',
        'date: 2026-01-01',
        'redirects:',
        '  - __test-fixture-renamed-old',
        '---',
        '',
        'Body.',
      ].join('\n')
    );

    const res = await request(app).get('/blog/__test-fixture-renamed-old');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/blog/__test-fixture-renamed-new');
  });

  it('skips a post missing required frontmatter instead of erroring the whole index', async () => {
    await writeFixture('broken', ['---', 'description: No title or slug here.', '---', '', 'Broken.'].join('\n'));

    const res = await request(app).get('/blog');
    expect(res.status).toBe(200);
  });

  it('keeps only the first post when two share a slug', async () => {
    await writeFixture(
      'dupe-a',
      ['---', 'title: Dupe A', 'slug: __test-fixture-dupe', 'description: First.', 'date: 2026-01-01', '---', '', 'A'].join('\n')
    );
    await writeFixture(
      'dupe-b',
      ['---', 'title: Dupe B', 'slug: __test-fixture-dupe', 'description: Second.', 'date: 2026-01-02', '---', '', 'B'].join('\n')
    );

    const posts = await listPosts({ includeDrafts: true });
    const matches = posts.filter((p) => p.slug === '__test-fixture-dupe');
    expect(matches).toHaveLength(1);
  });

  it('falls back to the default author when none is set, and resolves a known one', async () => {
    await writeFixture(
      'no-author',
      ['---', 'title: No Author', 'slug: __test-fixture-no-author', 'description: d.', 'date: 2026-01-01', '---', '', 'Body.'].join('\n')
    );
    await writeFixture(
      'known-author',
      ['---', 'title: Known Author', 'slug: __test-fixture-known-author', 'description: d.', 'date: 2026-01-01', 'author: nathan', '---', '', 'Body.'].join(
        '\n'
      )
    );

    const posts = await listPosts();
    const noAuthor = posts.find((p) => p.slug === '__test-fixture-no-author');
    const knownAuthor = posts.find((p) => p.slug === '__test-fixture-known-author');
    expect(noAuthor.author.name).toBe('Nathan');
    expect(noAuthor.author.initial).toBe('N');
    expect(knownAuthor.author.name).toBe('Nathan');
  });

  it('picks up an author avatar dropped into public/images/authors by id, with no code change', async () => {
    const avatarFile = 'nathan.jpg';
    await fs.writeFile(path.join(authorAvatarDir, avatarFile), Buffer.from([0xff, 0xd8, 0xff]));
    writtenAvatars.push(avatarFile);

    await writeFixture(
      'avatar',
      ['---', 'title: Avatar Post', 'slug: __test-fixture-avatar', 'description: d.', 'date: 2026-01-01', 'author: nathan', '---', '', 'Body.'].join('\n')
    );

    const post = await request(app).get('/blog/__test-fixture-avatar');
    expect(post.text).toContain('/images/authors/nathan.jpg');

    const index = await request(app).get('/blog');
    expect(index.text).toContain('/images/authors/nathan.jpg');
  });

  it('falls back to the initial-letter badge when no avatar file matches the author id', async () => {
    const posts = await listPosts();
    const post = posts.find((p) => p.author.name === 'Nathan');
    // No avatar fixture written in this test — the real content dir has no matching file either.
    expect(post.author.avatar).toBeNull();
  });

  it('renders tag pills on the post and the index card', async () => {
    // Dated far in the future so it always sorts onto page 1 of the index, regardless of how
    // much real content exists — the index assertion below needs the fixture on the page it
    // actually requests (the default, page 1).
    await writeFixture(
      'tagged',
      ['---', 'title: Tagged Post', 'slug: __test-fixture-tagged', 'description: d.', 'date: 2099-01-01', 'tags: ["Guides", "Product"]', '---', '', 'Body.'].join(
        '\n'
      )
    );

    const post = await request(app).get('/blog/__test-fixture-tagged');
    expect(post.text).toContain('Guides');
    expect(post.text).toContain('Product');

    const index = await request(app).get('/blog');
    expect(index.text).toContain('Tagged Post');
  });

  it('builds a table of contents from ## headings and gives them stable anchor ids', async () => {
    await writeFixture(
      'toc',
      [
        '---',
        'title: TOC Post',
        'slug: __test-fixture-toc',
        'description: d.',
        'date: 2026-01-01',
        '---',
        '',
        '## First Section',
        '',
        'Some text.',
        '',
        '## Second Section',
        '',
        'More text.',
      ].join('\n')
    );

    const posts = await listPosts();
    const post = posts.find((p) => p.slug === '__test-fixture-toc');
    expect(post.toc).toEqual([
      { text: 'First Section', slug: 'first-section' },
      { text: 'Second Section', slug: 'second-section' },
    ]);
    expect(post.html).toContain('<h2 id="first-section">');

    const res = await request(app).get('/blog/__test-fixture-toc');
    expect(res.text).toContain('has-toc');
    expect(res.text).toContain('href="#first-section"');
  });

  it('generates deterministic card art for posts with no explicit image', async () => {
    const posts = await listPosts();
    const post = posts.find((p) => !p.image);
    expect(post).toBeTruthy();
    expect(post.cardArt.palette).toBeGreaterThanOrEqual(1);
    expect(post.cardArt.palette).toBeLessThanOrEqual(6);
    expect(post.cardArt.icon).toBeGreaterThanOrEqual(0);
    expect(post.cardArt.icon).toBeLessThanOrEqual(3);

    // Re-reading the same post (no caching) must yield the same art, not a new roll each time.
    const again = (await listPosts()).find((p) => p.slug === post.slug);
    expect(again.cardArt).toEqual(post.cardArt);

    const res = await request(app).get('/blog');
    expect(res.text).toContain(`blog-card-thumb-${post.cardArt.palette}`);
  });

  it('builds a category pill list from post tags and filters the grid by category', async () => {
    await writeFixture(
      'cat-a',
      ['---', 'title: Category A Post', 'slug: __test-fixture-cat-a', 'description: d.', 'date: 2026-01-01', 'tags: ["ZzzUniqueCategory"]', '---', '', 'Body.'].join(
        '\n'
      )
    );
    await writeFixture(
      'cat-b',
      ['---', 'title: Category B Post', 'slug: __test-fixture-cat-b', 'description: d.', 'date: 2026-01-01', 'tags: ["Other"]', '---', '', 'Body.'].join('\n')
    );

    const posts = await listPosts();
    const cats = categories(posts);
    expect(cats).toContain('ZzzUniqueCategory');

    const filtered = filterByCategory(posts, 'zzzuniquecategory');
    expect(filtered.map((p) => p.slug)).toContain('__test-fixture-cat-a');
    expect(filtered.map((p) => p.slug)).not.toContain('__test-fixture-cat-b');

    const res = await request(app).get('/blog?category=ZzzUniqueCategory');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Category A Post');
    expect(res.text).not.toContain('Category B Post');
    expect(res.text).toContain('blog-filter-pill active');
  });

  it('has no "Contents" sidebar for a post with no ## headings', async () => {
    await writeFixture(
      'no-toc',
      ['---', 'title: No TOC Post', 'slug: __test-fixture-no-toc', 'description: d.', 'date: 2026-01-01', '---', '', 'Just a paragraph, no headings.'].join(
        '\n'
      )
    );

    const res = await request(app).get('/blog/__test-fixture-no-toc');
    expect(res.text).not.toContain('has-toc');
    expect(res.text).not.toContain('Table of contents');
  });
});

describe('sitemap and robots', () => {
  it('GET /sitemap.xml includes the blog index and posts', async () => {
    const res = await request(app).get('/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.type).toBe('application/xml');
    expect(res.text).toContain('<urlset');
    expect(res.text).toContain('/blog</loc>');
  });

  it('GET /robots.txt points at the sitemap', async () => {
    const res = await request(app).get('/robots.txt');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Sitemap:');
    expect(res.text).toContain('/sitemap.xml');
  });
});

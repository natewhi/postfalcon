# Author avatars

Drop an image here named after an author's id (the same key used in `AUTHORS` in
[`lib/blog.js`](../../../lib/blog.js) and in a post's `author:` frontmatter field) and it's
picked up automatically — no code change, no restart needed.

```
public/images/authors/nathan.jpg
```

Accepted filenames, checked in this order (first match wins): `<id>.webp`, `<id>.jpg`,
`<id>.jpeg`, `<id>.png`.

If no matching file exists, the byline falls back to a plain letter badge (the author's
first initial) — that's normal, not a bug, until a photo is added.

This directory is separate from `public/uploads/` on purpose: the daily media-cleanup job
(`scheduler.js`) only ever touches post attachments under `uploads/`, so avatar files placed
here are never swept up by it.

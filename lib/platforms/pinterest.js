// Pinterest Pins are inherently image/video objects — there's no text-only Pin type, so unlike
// every other adapter here a Pin always needs media. The image just needs to be a public URL
// (uploaded media already is one — BASE_URL/uploads/<file>), so no upload dance is needed, only
// a single API call. Video pins need Pinterest's separate media-upload flow — not built yet.
// Pins always post to one board, chosen at connect time and stored in social_accounts.metadata
// (same place Mastodon stores its instance domain).
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

  const res = await fetch('https://api.pinterest.com/v5/pins', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${post.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      board_id: boardId,
      description: post.content,
      media_source: { source_type: 'image_url', url: image.url },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Pinterest pin failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data.id;
}

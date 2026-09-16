// LinkedIn's versioned Posts API (the "Share on LinkedIn" product — w_member_social scope,
// available to any registered app without the Marketing Developer Platform partner approval
// that gates Company Page / analytics APIs). Personal-profile text posts only for now: image/
// video requires LinkedIn's separate multi-step asset-registration upload flow, not built yet.
const LINKEDIN_API_VERSION = '202401';

export async function publish(post) {
  const media = post.media || [];
  if (media.length > 0) {
    throw new Error('LinkedIn image/video posting is not supported yet — remove attached media or post text only.');
  }

  const res = await fetch('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${post.access_token}`,
      'Content-Type': 'application/json',
      'LinkedIn-Version': LINKEDIN_API_VERSION,
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify({
      author: `urn:li:person:${post.external_account_id}`,
      commentary: post.content,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LinkedIn post failed (${res.status}): ${body}`);
  }
  // LinkedIn's Posts API returns 201 with the new post's URN in a response header, not the body.
  return res.headers.get('x-restli-id') || res.headers.get('x-linkedin-id') || null;
}

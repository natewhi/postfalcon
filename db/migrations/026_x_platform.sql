-- X gets a real adapter under the id 'x' (lib/platforms/x.js, unlisted until launched). The old
-- 'twitter' id stays as the never-offered placeholder the test suite uses as its generic stub.
ALTER TABLE social_accounts DROP CONSTRAINT IF EXISTS social_accounts_platform_check;

ALTER TABLE social_accounts ADD CONSTRAINT social_accounts_platform_check CHECK (
  platform IN (
    'facebook', 'instagram', 'mastodon',
    'youtube', 'tiktok', 'telegram', 'bluesky', 'threads',
    'pinterest', 'linkedin', 'reddit', 'google_business',
    'twitter', 'x'
  )
);

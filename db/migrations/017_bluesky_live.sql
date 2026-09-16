-- Bluesky goes live (threads was already allowed by migration 016). See lib/platforms.js.
ALTER TABLE social_accounts DROP CONSTRAINT IF EXISTS social_accounts_platform_check;

ALTER TABLE social_accounts ADD CONSTRAINT social_accounts_platform_check CHECK (
  platform IN (
    'facebook', 'instagram', 'mastodon',
    'youtube', 'tiktok', 'telegram', 'bluesky', 'threads',
    'pinterest', 'reddit', 'linkedin',
    'twitter'
  )
);

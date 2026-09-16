-- Pinterest and LinkedIn go live (see lib/platforms.js) — both were already allowed by migration
-- 017's CHECK, so only the new google_business stub id needs adding here.
ALTER TABLE social_accounts DROP CONSTRAINT IF EXISTS social_accounts_platform_check;

ALTER TABLE social_accounts ADD CONSTRAINT social_accounts_platform_check CHECK (
  platform IN (
    'facebook', 'instagram', 'mastodon',
    'youtube', 'tiktok', 'telegram', 'bluesky', 'threads',
    'pinterest', 'linkedin', 'reddit', 'google_business',
    'twitter'
  )
);

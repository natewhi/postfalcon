-- Widen social_accounts.platform to the full platform registry (lib/platforms.js).
-- Adds youtube/whatsapp/wechat/telegram/messenger/snapchat/douyin alongside the original
-- seven. New rows are validated against the zod enum in routes/socialAccounts.js (sourced
-- from that registry); this CHECK is defense in depth and must be kept in sync with it.
ALTER TABLE social_accounts DROP CONSTRAINT IF EXISTS social_accounts_platform_check;

ALTER TABLE social_accounts ADD CONSTRAINT social_accounts_platform_check CHECK (
  platform IN (
    'facebook', 'instagram', 'mastodon',
    'youtube', 'tiktok', 'telegram',
    'whatsapp', 'wechat', 'messenger', 'snapchat', 'douyin',
    'twitter', 'linkedin', 'threads'
  )
);

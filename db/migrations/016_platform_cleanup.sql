-- Drop the chat-app platform ids (whatsapp/wechat/messenger/snapchat/douyin) — none of them
-- have a public content-publishing API, and Postfox schedules social *posts*, not chat
-- messages, so they were never postable and just cluttered the connect page. No real account
-- could exist with these ids (they were `connect: 'none'` the whole time), so this is a safe
-- narrowing. Widen the constraint for two real, popular, non-chat platforms targeted next
-- (pinterest, reddit) alongside the existing hidden linkedin/threads ids. See lib/platforms.js.
ALTER TABLE social_accounts DROP CONSTRAINT IF EXISTS social_accounts_platform_check;

ALTER TABLE social_accounts ADD CONSTRAINT social_accounts_platform_check CHECK (
  platform IN (
    'facebook', 'instagram', 'mastodon',
    'youtube', 'tiktok', 'telegram',
    'pinterest', 'reddit', 'linkedin', 'threads',
    'twitter'
  )
);

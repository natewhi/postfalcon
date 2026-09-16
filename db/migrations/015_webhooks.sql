-- Outbound webhooks: per-user endpoints Postfox POSTs to when a scheduled post publishes
-- or fails. HMAC-signed with `secret`. Team/Pro capability (see lib/billing.js).
CREATE TABLE webhooks (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT[] NOT NULL DEFAULT ARRAY['post.published', 'post.failed'],
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_delivery_at TIMESTAMPTZ,
  last_delivery_status INT
);

CREATE INDEX idx_webhooks_user_id ON webhooks (user_id);

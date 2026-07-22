-- Same ON DELETE SET NULL rationale as migration 008: a deleted account's historical
-- usage still counts towards aggregate product metrics (e.g. "posts created per week"),
-- so the row is kept rather than cascaded away.

CREATE TABLE product_events (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  event_name TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_product_events_user_id ON product_events (user_id);
CREATE INDEX idx_product_events_created_at ON product_events (created_at);
CREATE INDEX idx_product_events_event_name ON product_events (event_name);

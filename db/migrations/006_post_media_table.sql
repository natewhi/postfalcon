ALTER TABLE posts DROP COLUMN media_url;
ALTER TABLE posts DROP COLUMN media_type;

CREATE TABLE post_media (
  id BIGSERIAL PRIMARY KEY,
  post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video')),
  alt_text TEXT,
  position INT NOT NULL DEFAULT 0
);

CREATE INDEX idx_post_media_post_id ON post_media (post_id);

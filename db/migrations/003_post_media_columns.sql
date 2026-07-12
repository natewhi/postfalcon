DROP TABLE post_media;

ALTER TABLE posts ADD COLUMN media_url TEXT;
ALTER TABLE posts ADD COLUMN media_type TEXT CHECK (media_type IN ('image', 'video'));

-- A camera can replay an uploaded video as if it were live (source_type 'media'): the live
-- process paces the file at its frame rate through the same pipeline as a stream. Unlike a demo
-- camera (a file an administrator put in demo-videos), it points at the user's own upload, which
-- cannot be deleted while a camera replays it. replay_loop: replay forever (like a demo camera)
-- instead of ending the session after one pass.
ALTER TABLE stream_sources DROP CONSTRAINT stream_sources_source_type_check;
ALTER TABLE stream_sources ADD CONSTRAINT stream_sources_source_type_check
    CHECK (source_type IN ('youtube', 'file', 'rtsp', 'media'));
ALTER TABLE stream_sources
    ADD COLUMN media_id varchar(32) REFERENCES media_assets(id) ON DELETE RESTRICT,
    ADD COLUMN replay_loop boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT stream_sources_media_source CHECK ((source_type = 'media') = (media_id IS NOT NULL));
CREATE INDEX stream_sources_media ON stream_sources (media_id) WHERE media_id IS NOT NULL;

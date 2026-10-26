-- Demo cameras: a video under PLATE_DATA_DIR/demo-videos replayed as a live source,
-- so a demonstration does not depend on the network. url then holds the relative path.
ALTER TABLE stream_sources DROP CONSTRAINT stream_sources_source_type_check;
ALTER TABLE stream_sources ADD CONSTRAINT stream_sources_source_type_check
    CHECK (source_type IN ('youtube', 'file'));

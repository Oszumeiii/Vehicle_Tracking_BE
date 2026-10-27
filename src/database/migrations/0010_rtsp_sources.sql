-- IP cameras: an rtsp:// or rtsps:// URL the live process opens with ffmpeg. The URL may
-- carry the camera's credentials; the API never returns them (src/live/payload.ts redactUrl).
ALTER TABLE stream_sources DROP CONSTRAINT stream_sources_source_type_check;
ALTER TABLE stream_sources ADD CONSTRAINT stream_sources_source_type_check
    CHECK (source_type IN ('youtube', 'file', 'rtsp'));

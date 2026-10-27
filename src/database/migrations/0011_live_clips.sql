-- Video clip of a live track (recognition/{job}/clip.mp4), cut by the live process from the
-- camera's rolling recording without re-encoding. Upload jobs have their source video instead.
ALTER TABLE recognition_jobs ADD COLUMN clip_storage_key text;
ALTER TABLE recognition_jobs ADD CONSTRAINT recognition_jobs_clip_live
    CHECK (clip_storage_key IS NULL OR live_session_id IS NOT NULL);

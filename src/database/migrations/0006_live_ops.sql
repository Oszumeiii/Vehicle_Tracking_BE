-- Long-running live operation: always-on cameras restarted by the worker, evidence
-- retention per camera, vehicle sightings that group tracks of the same plate, and
-- the bookkeeping retention needs (protected tracks, stored bytes, pruning time).
ALTER TABLE stream_sources
    ADD COLUMN always_on boolean NOT NULL DEFAULT false,
    ADD COLUMN auto_settings jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN keyframe_retention_hours integer DEFAULT 24 CHECK (keyframe_retention_hours >= 0),
    ADD COLUMN track_retention_days integer DEFAULT 7 CHECK (track_retention_days >= 0),
    ADD CONSTRAINT stream_sources_auto_settings_object CHECK (jsonb_typeof(auto_settings) = 'object'),
    ADD CONSTRAINT stream_sources_always_on_pipeline CHECK (
        NOT always_on OR auto_settings ? 'pipeline_id'
    );

ALTER TABLE recognition_jobs
    -- Group key (the first track's job id), not a foreign key: deleting that track keeps the group.
    ADD COLUMN sighting_id varchar(32),
    ADD COLUMN alerted boolean NOT NULL DEFAULT false,
    ADD COLUMN evidence_bytes bigint CHECK (evidence_bytes >= 0),
    ADD COLUMN evidence_pruned_at timestamptz,
    ADD CONSTRAINT recognition_jobs_sighting_live CHECK (
        sighting_id IS NULL OR live_session_id IS NOT NULL
    );
UPDATE recognition_jobs SET sighting_id = id WHERE live_session_id IS NOT NULL;
CREATE INDEX recognition_jobs_sighting ON recognition_jobs(sighting_id) WHERE sighting_id IS NOT NULL;
CREATE INDEX recognition_jobs_live_captured_to ON recognition_jobs(live_session_id, captured_to)
    WHERE live_session_id IS NOT NULL;

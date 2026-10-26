-- YouTube Live recognition. A stream source is a camera owned like media; a live
-- session is one run of the live process on it. Every finished track becomes a
-- succeeded recognition job of that session, so review, evidence, search and CSV
-- reuse the upload paths. Confidence status and duplicate links are advisory.
CREATE TABLE stream_sources (
    id varchar(32) PRIMARY KEY,
    owner_id varchar(32) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    name varchar(200) NOT NULL,
    source_type varchar(16) NOT NULL DEFAULT 'youtube' CHECK (source_type IN ('youtube')),
    url text NOT NULL,
    -- Normalized [x1, y1, x2, y2] rectangles; detections centred inside are ignored.
    exclude_zones jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT stream_sources_exclude_zones_array CHECK (jsonb_typeof(exclude_zones) = 'array')
);
CREATE INDEX stream_sources_owner_created ON stream_sources(owner_id, created_at DESC);

CREATE TABLE live_sessions (
    id varchar(32) PRIMARY KEY,
    stream_source_id varchar(32) NOT NULL REFERENCES stream_sources(id) ON DELETE RESTRICT,
    requested_by varchar(32) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    pipeline_snapshot jsonb NOT NULL,
    settings jsonb NOT NULL DEFAULT '{}'::jsonb,
    status varchar(16) NOT NULL DEFAULT 'queued' CHECK (status IN (
        'queued', 'starting', 'running', 'reconnecting', 'stopping',
        'stopped', 'ended', 'failed', 'interrupted'
    )),
    stop_requested_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    error_code varchar(100),
    error_message text,
    stats jsonb NOT NULL DEFAULT '{}'::jsonb,
    stats_at timestamptz,
    tracks_count integer NOT NULL DEFAULT 0 CHECK (tracks_count >= 0),
    CONSTRAINT live_sessions_snapshot_object CHECK (jsonb_typeof(pipeline_snapshot) = 'object'),
    CONSTRAINT live_sessions_settings_object CHECK (jsonb_typeof(settings) = 'object'),
    CONSTRAINT live_sessions_stats_object CHECK (jsonb_typeof(stats) = 'object')
);
CREATE INDEX live_sessions_queue ON live_sessions(status, created_at, id);
CREATE INDEX live_sessions_source_created ON live_sessions(stream_source_id, created_at DESC, id DESC);
-- One active session per camera.
CREATE UNIQUE INDEX live_sessions_one_active ON live_sessions(stream_source_id)
    WHERE status IN ('queued', 'starting', 'running', 'reconnecting', 'stopping');

CREATE TABLE live_session_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id varchar(32) NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
    event_type varchar(32) NOT NULL CHECK (event_type IN ('status', 'error', 'track_rejected')),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT live_session_events_payload_object CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX live_session_events_session ON live_session_events(session_id, id);

ALTER TABLE recognition_jobs
    ALTER COLUMN media_id DROP NOT NULL,
    ADD COLUMN live_session_id varchar(32) REFERENCES live_sessions(id) ON DELETE RESTRICT,
    ADD COLUMN live_track_key varchar(32),
    ADD COLUMN captured_from timestamptz,
    ADD COLUMN captured_to timestamptz,
    ADD COLUMN confidence_status varchar(16) CHECK (
        confidence_status IN ('readable', 'low_confidence', 'unreadable')
    ),
    ADD COLUMN duplicate_of_job_id varchar(32) REFERENCES recognition_jobs(id) ON DELETE SET NULL,
    ADD CONSTRAINT recognition_jobs_one_source CHECK ((media_id IS NULL) <> (live_session_id IS NULL)),
    ADD CONSTRAINT recognition_jobs_live_fields CHECK (
        (live_session_id IS NULL AND live_track_key IS NULL AND captured_from IS NULL
            AND captured_to IS NULL AND confidence_status IS NULL AND duplicate_of_job_id IS NULL)
        OR
        (live_session_id IS NOT NULL AND live_track_key IS NOT NULL AND captured_from IS NOT NULL
            AND captured_to >= captured_from AND confidence_status IS NOT NULL)
    ),
    ADD CONSTRAINT recognition_jobs_live_track UNIQUE (live_session_id, live_track_key);
CREATE INDEX recognition_jobs_live_captured ON recognition_jobs(live_session_id, captured_from)
    WHERE live_session_id IS NOT NULL;

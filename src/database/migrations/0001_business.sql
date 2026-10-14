-- IDs are generated as UUID hex strings by the application. Evidence is stored
-- outside PostgreSQL using relative storage keys. Server-only pipeline snapshots
-- may contain checkpoint paths; API serializers must not expose those paths.
CREATE TABLE users (
    id varchar(32) PRIMARY KEY,
    email varchar(320) NOT NULL UNIQUE,
    password_hash text NOT NULL,
    display_name varchar(200) NOT NULL DEFAULT '',
    role varchar(16) NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_normalized_email CHECK (email = lower(btrim(email)))
);

CREATE TABLE auth_sessions (
    id varchar(32) PRIMARY KEY,
    user_id varchar(32) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash varchar(64) NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user_expiry ON auth_sessions(user_id, expires_at);

CREATE TABLE media_assets (
    id varchar(32) PRIMARY KEY,
    owner_id varchar(32) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    original_name varchar(255) NOT NULL,
    media_type varchar(16) NOT NULL CHECK (media_type IN ('image', 'video')),
    storage_key text NOT NULL UNIQUE,
    mime_type varchar(100) NOT NULL,
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
    sha256 varchar(64) NOT NULL,
    width integer CHECK (width > 0),
    height integer CHECK (height > 0),
    duration_seconds double precision CHECK (duration_seconds >= 0),
    uploaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_assets_owner_uploaded ON media_assets(owner_id, uploaded_at DESC);

CREATE TABLE recognition_jobs (
    id varchar(32) PRIMARY KEY,
    media_id varchar(32) NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
    job_kind varchar(16) NOT NULL DEFAULT 'recognize' CHECK (job_kind IN ('detect_only', 'recognize')),
    input_mode varchar(16) NOT NULL DEFAULT 'scene' CHECK (input_mode IN ('scene', 'plate_crop')),
    pipeline_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    status varchar(16) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    stage varchar(32) NOT NULL DEFAULT 'queued',
    statistics jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    error_code varchar(100),
    error_message text,
    CONSTRAINT recognition_jobs_snapshot_object CHECK (jsonb_typeof(pipeline_snapshot) = 'object'),
    CONSTRAINT recognition_jobs_statistics_object CHECK (jsonb_typeof(statistics) = 'object')
);
CREATE INDEX recognition_jobs_queue ON recognition_jobs(status, created_at, id);
CREATE INDEX recognition_jobs_media_created ON recognition_jobs(media_id, created_at DESC, id DESC);

CREATE TABLE plate_appearances (
    id varchar(32) PRIMARY KEY,
    job_id varchar(32) NOT NULL REFERENCES recognition_jobs(id) ON DELETE CASCADE,
    source_track_id varchar(100),
    first_frame integer CHECK (first_frame >= 0),
    last_frame integer CHECK (last_frame >= first_frame),
    start_seconds double precision CHECK (start_seconds >= 0),
    end_seconds double precision CHECK (end_seconds >= start_seconds),
    machine_text varchar(128),
    machine_status varchar(16) NOT NULL DEFAULT 'not_run' CHECK (machine_status IN ('readable', 'ambiguous', 'unreadable', 'not_run')),
    agreement_count integer NOT NULL DEFAULT 0 CHECK (agreement_count BETWEEN 0 AND 5),
    effective_text varchar(128),
    review_status varchar(16) NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'confirmed', 'corrected', 'unreadable', 'rejected')),
    revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
CREATE INDEX plate_appearances_job ON plate_appearances(job_id);
CREATE INDEX plate_appearances_effective_text ON plate_appearances(effective_text);
CREATE INDEX plate_appearances_review_status ON plate_appearances(review_status);

CREATE TABLE plate_detections (
    id varchar(32) PRIMARY KEY,
    appearance_id varchar(32) NOT NULL REFERENCES plate_appearances(id) ON DELETE CASCADE,
    selected_order integer NOT NULL DEFAULT 0 CHECK (selected_order >= 0),
    frame_index integer CHECK (frame_index >= 0),
    timestamp_seconds double precision CHECK (timestamp_seconds >= 0),
    timestamp_source varchar(32),
    bbox jsonb,
    crop_bbox jsonb,
    detection_score double precision CHECK (detection_score BETWEEN 0 AND 1),
    crop_storage_key text NOT NULL,
    frame_storage_key text,
    crop_width integer CHECK (crop_width > 0),
    crop_height integer CHECK (crop_height > 0),
    legacy_crop_id varchar(100),
    CONSTRAINT plate_detections_selected_order UNIQUE (appearance_id, selected_order)
);
CREATE INDEX plate_detections_legacy_crop ON plate_detections(legacy_crop_id);

CREATE TABLE ocr_predictions (
    id varchar(32) PRIMARY KEY,
    detection_id varchar(32) NOT NULL REFERENCES plate_detections(id) ON DELETE CASCADE,
    variant varchar(32) NOT NULL DEFAULT 'original',
    raw_text text,
    normalized_text varchar(128),
    ocr_score double precision,
    character_scores jsonb,
    input_storage_key text NOT NULL,
    latency_ms double precision CHECK (latency_ms >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ocr_predictions_variant UNIQUE (detection_id, variant)
);

CREATE TABLE recognition_reviews (
    id varchar(32) PRIMARY KEY,
    appearance_id varchar(32) NOT NULL REFERENCES plate_appearances(id) ON DELETE CASCADE,
    reviewer_id varchar(32) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    action varchar(16) NOT NULL CHECK (action IN ('confirm', 'correct', 'unreadable', 'reject')),
    corrected_text varchar(128),
    note text,
    revision integer NOT NULL CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT recognition_reviews_revision UNIQUE (appearance_id, revision)
);
CREATE INDEX recognition_reviews_reviewer ON recognition_reviews(reviewer_id);

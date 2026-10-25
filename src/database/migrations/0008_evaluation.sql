-- Independent labelling of live tracks for threshold calibration (docs/EVALUATION.md).
-- Labels are kept apart from in-app reviews: labellers never see machine output, and
-- reviews are never used as ground truth.
CREATE TABLE evaluation_sets (
    id varchar(32) PRIMARY KEY,
    name varchar(200) NOT NULL,
    created_by varchar(32) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    stream_source_id varchar(32) REFERENCES stream_sources(id) ON DELETE SET NULL,
    live_session_id varchar(32) REFERENCES live_sessions(id) ON DELETE SET NULL,
    params jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT evaluation_sets_params_object CHECK (jsonb_typeof(params) = 'object')
);
CREATE INDEX evaluation_sets_created ON evaluation_sets(created_at DESC, id DESC);

CREATE TABLE evaluation_items (
    id varchar(32) PRIMARY KEY,
    set_id varchar(32) NOT NULL REFERENCES evaluation_sets(id) ON DELETE CASCADE,
    job_id varchar(32) NOT NULL REFERENCES recognition_jobs(id) ON DELETE CASCADE,
    -- Index of the confidence bin the item was sampled from (stratified sampling).
    bin smallint NOT NULL CHECK (bin >= 0),
    UNIQUE (set_id, job_id)
);
-- Retention looks up whether a track belongs to a set.
CREATE INDEX evaluation_items_job ON evaluation_items(job_id);

CREATE TABLE evaluation_labels (
    item_id varchar(32) NOT NULL REFERENCES evaluation_items(id) ON DELETE CASCADE,
    labeler_id varchar(32) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Normalized plate the labeller read; NULL when a person cannot read it either.
    plate_text varchar(32) CHECK (plate_text IS NULL OR plate_text <> ''),
    labeled_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (item_id, labeler_id)
);

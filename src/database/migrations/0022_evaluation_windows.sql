-- Labelling by stretches of a replayed video (docs/EVALUATION.md): a set made of time
-- windows holds every track the system found in them, and labellers record the vehicles it
-- missed, so recall can be measured as well as reading accuracy.
ALTER TABLE evaluation_items ADD COLUMN window_index smallint CHECK (window_index >= 0);

CREATE TABLE evaluation_misses (
    id varchar(32) PRIMARY KEY,
    set_id varchar(32) NOT NULL REFERENCES evaluation_sets(id) ON DELETE CASCADE,
    labeler_id varchar(32) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    window_index smallint NOT NULL CHECK (window_index >= 0),
    -- Position in the replayed video where the missed plate is clearest.
    video_seconds double precision NOT NULL CHECK (video_seconds >= 0),
    -- Normalized plate; NULL when the labeller saw a vehicle but could not read it.
    plate_text varchar(32) CHECK (plate_text IS NULL OR plate_text <> ''),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evaluation_misses_set ON evaluation_misses(set_id, labeler_id, video_seconds);

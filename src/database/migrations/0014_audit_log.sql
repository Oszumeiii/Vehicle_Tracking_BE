-- Who did what: sign-ins, plate searches and journeys, evidence views and exports, and
-- changes to cameras, watchlists, users and data. Read by administrators only. Never
-- holds passwords or tokens; rows outlive deleted users (user_id is kept, not a FK).
CREATE TABLE audit_log (
    id bigserial PRIMARY KEY,
    user_id varchar(32),
    action varchar(64) NOT NULL,
    target_type varchar(32),
    target_id varchar(64),
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    ip varchar(64),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT audit_log_details_object CHECK (jsonb_typeof(details) = 'object')
);
CREATE INDEX audit_log_created ON audit_log (created_at DESC, id DESC);
CREATE INDEX audit_log_user_created ON audit_log (user_id, created_at DESC);
CREATE INDEX audit_log_action_created ON audit_log (action, created_at DESC);

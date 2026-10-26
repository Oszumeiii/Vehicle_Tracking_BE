-- Real-time live events. Finished tracks and watchlist alerts join the durable
-- session history, so one increasing id sequence lets clients resume a stream.
-- NOTIFY is delivered at commit: listeners never see uncommitted rows.
ALTER TABLE live_session_events
    DROP CONSTRAINT live_session_events_event_type_check,
    ADD CONSTRAINT live_session_events_event_type_check CHECK (
        event_type IN ('status', 'error', 'track_rejected', 'track', 'alert')
    );

CREATE FUNCTION notify_live_session_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('live_session_events', NEW.session_id || ':' || NEW.id);
    RETURN NULL;
END;
$$;
CREATE TRIGGER live_session_events_notify AFTER INSERT ON live_session_events
    FOR EACH ROW EXECUTE FUNCTION notify_live_session_event();

CREATE FUNCTION notify_live_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('live_sessions', NEW.id);
    RETURN NULL;
END;
$$;
CREATE TRIGGER live_sessions_notify AFTER UPDATE ON live_sessions
    FOR EACH ROW EXECUTE FUNCTION notify_live_session();

-- Plates a user wants to be alerted about when a live camera reads them.
CREATE TABLE plate_watchlist (
    id varchar(32) PRIMARY KEY,
    owner_id varchar(32) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plate varchar(16) NOT NULL,
    note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT plate_watchlist_normalized CHECK (
        plate <> '' AND plate = upper(plate) AND plate !~ '[[:space:]-]'
    ),
    CONSTRAINT plate_watchlist_owner_plate UNIQUE (owner_id, plate)
);

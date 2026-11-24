-- Watchlist entries say why a plate is watched, how urgent it is and until when; an admin
-- can share an entry with everyone who sees the camera. Alerts also leave the app
-- (Telegram, webhook): ingesting a track writes deliveries in the same transaction and
-- the worker sends and retries them.
ALTER TABLE plate_watchlist
    ADD COLUMN reason varchar(16) NOT NULL DEFAULT 'other'
        CONSTRAINT plate_watchlist_reason CHECK (reason IN ('stolen', 'wanted', 'suspect', 'vip', 'other')),
    ADD COLUMN priority varchar(8) NOT NULL DEFAULT 'normal'
        CONSTRAINT plate_watchlist_priority CHECK (priority IN ('low', 'normal', 'high')),
    ADD COLUMN expires_at timestamptz,
    ADD COLUMN shared boolean NOT NULL DEFAULT false,
    ADD COLUMN updated_at timestamptz;

CREATE INDEX plate_watchlist_shared ON plate_watchlist (created_at DESC) WHERE shared;

-- Where a user's alerts go: a Telegram chat (target = chat id, linked through the bot)
-- or an HTTPS webhook (target = URL, requests signed with secret).
CREATE TABLE notification_channels (
    id varchar(32) PRIMARY KEY,
    owner_id varchar(32) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind varchar(16) NOT NULL
        CONSTRAINT notification_channels_kind CHECK (kind IN ('telegram', 'webhook')),
    target text NOT NULL CONSTRAINT notification_channels_target_length CHECK (length(target) BETWEEN 1 AND 2000),
    label varchar(100),
    secret varchar(64),
    min_priority varchar(8) NOT NULL DEFAULT 'low'
        CONSTRAINT notification_channels_min_priority CHECK (min_priority IN ('low', 'normal', 'high')),
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_sent_at timestamptz,
    last_error text,
    last_error_at timestamptz,
    CONSTRAINT notification_channels_owner_target UNIQUE (owner_id, kind, target),
    CONSTRAINT notification_channels_webhook_secret CHECK (kind <> 'webhook' OR secret IS NOT NULL)
);

-- One message to one channel. payload is what the message says, fixed when the alert fired.
CREATE TABLE alert_deliveries (
    id varchar(32) PRIMARY KEY,
    channel_id varchar(32) NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
    job_id varchar(32) REFERENCES recognition_jobs(id) ON DELETE SET NULL,
    payload jsonb NOT NULL,
    status varchar(8) NOT NULL DEFAULT 'pending'
        CONSTRAINT alert_deliveries_status CHECK (status IN ('pending', 'sent', 'failed')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz
);

CREATE INDEX alert_deliveries_due ON alert_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX alert_deliveries_channel ON alert_deliveries (channel_id, created_at DESC);

-- One-time codes of the Telegram deep link (t.me/<bot>?start=<code>) that ties a chat to a user.
CREATE TABLE telegram_link_codes (
    code varchar(32) PRIMARY KEY,
    owner_id varchar(32) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    used_at timestamptz
);

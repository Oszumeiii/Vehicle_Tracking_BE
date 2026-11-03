-- Uploaded footage joins journeys once it says where and when it was filmed: recorded_at is
-- the wall-clock time of the video's first frame, so a result's time is recorded_at + its
-- start_seconds. Same location shape as stream_sources (WGS84, both or neither).
ALTER TABLE media_assets
    ADD COLUMN recorded_at timestamptz,
    ADD COLUMN latitude double precision,
    ADD COLUMN longitude double precision,
    ADD COLUMN location_name varchar(200),
    ADD COLUMN heading smallint,
    ADD CONSTRAINT media_assets_location_pair CHECK ((latitude IS NULL) = (longitude IS NULL)),
    ADD CONSTRAINT media_assets_latitude_range CHECK (latitude BETWEEN -90 AND 90),
    ADD CONSTRAINT media_assets_longitude_range CHECK (longitude BETWEEN -180 AND 180),
    ADD CONSTRAINT media_assets_heading_range CHECK (heading BETWEEN 0 AND 359);

-- Brazilian plates: converting an old plate (LLLNNNN) to Mercosul (LLLNLNN) replaces the
-- fifth character's digit d with the letter 'A'+d (ABC1234 -> ABC1C34). The skeleton maps
-- such a fifth letter back to its digit, so both plates of one vehicle match, then folds the
-- characters OCR confuses as before (O/D/Q->0, I/L->1, Z->2, S->5, B->8, G->6).
DROP INDEX plate_appearances_effective_skeleton;
CREATE OR REPLACE FUNCTION plate_skeleton(text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
    SELECT translate(
        CASE WHEN length(p) = 7 AND substr(p, 5, 1) BETWEEN 'A' AND 'J'
            THEN overlay(p PLACING chr(ascii(substr(p, 5, 1)) - 17) FROM 5 FOR 1)
            ELSE p END,
        'ODQILZSBG', '000112586')
    FROM (SELECT upper($1) AS p) plate
    $$;
CREATE INDEX plate_appearances_effective_skeleton ON plate_appearances (plate_skeleton(effective_text));

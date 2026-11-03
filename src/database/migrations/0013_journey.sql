-- Where each camera is, so a plate's sightings across cameras form a journey on a map.
-- Coordinates are WGS84 degrees; both or neither. heading: compass direction the camera faces.
ALTER TABLE stream_sources
    ADD COLUMN latitude double precision,
    ADD COLUMN longitude double precision,
    ADD COLUMN location_name varchar(200),
    ADD COLUMN heading smallint,
    ADD CONSTRAINT stream_sources_location_pair CHECK ((latitude IS NULL) = (longitude IS NULL)),
    ADD CONSTRAINT stream_sources_latitude_range CHECK (latitude BETWEEN -90 AND 90),
    ADD CONSTRAINT stream_sources_longitude_range CHECK (longitude BETWEEN -180 AND 180),
    ADD CONSTRAINT stream_sources_heading_range CHECK (heading BETWEEN 0 AND 359);

-- Approximate plate search: levenshtein() over plate_skeleton(), which folds the
-- characters OCR confuses (O/D/Q->0, I/L->1, Z->2, S->5, B->8, G->6).
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;
CREATE FUNCTION plate_skeleton(text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$ SELECT translate(upper($1), 'ODQILZSBG', '000112586') $$;
CREATE INDEX plate_appearances_effective_skeleton ON plate_appearances (plate_skeleton(effective_text));

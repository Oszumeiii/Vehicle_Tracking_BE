-- The team lowered the default readable threshold back to 0.85 (15/11/2026): on the live
-- cameras almost no track reached 0.96, so nothing was marked readable. On labelled ICPR
-- tracks 0.85 gives about 87% precision instead of 96% (docs/EVALUATION.md). Cameras
-- saved with the previous default follow it; any other value was chosen by hand and is
-- kept. A camera that chose exactly 0.96 on purpose cannot be told apart and moves too.
UPDATE stream_sources
SET auto_settings = jsonb_set(auto_settings, '{min_confidence}', '0.85'::jsonb)
WHERE auto_settings -> 'min_confidence' = '0.96'::jsonb;

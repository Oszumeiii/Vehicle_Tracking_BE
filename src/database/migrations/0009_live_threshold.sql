-- The default readable threshold rose from 0.85 to 0.96 after calibration on labelled
-- ICPR tracks (docs/EVALUATION.md). Cameras saved with the old default follow it; any
-- other value was chosen by hand and is kept. A camera that chose exactly 0.85 on
-- purpose cannot be told apart and moves too.
UPDATE stream_sources
SET auto_settings = jsonb_set(auto_settings, '{min_confidence}', '0.96'::jsonb)
WHERE auto_settings -> 'min_confidence' = '0.85'::jsonb;

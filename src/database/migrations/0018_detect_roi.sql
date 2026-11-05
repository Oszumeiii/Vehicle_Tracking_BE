-- Detection region of a camera: normalized [x1, y1, x2, y2]. The detector runs on that part of
-- the frame only, scaled up to its input size, so small plates in the lanes near the camera are
-- found; tracking and OCR crops still use the full frame. Null: the whole frame (as before).
ALTER TABLE stream_sources
    ADD COLUMN detect_roi jsonb,
    ADD CONSTRAINT stream_sources_detect_roi_box CHECK (
        detect_roi IS NULL OR (jsonb_typeof(detect_roi) = 'array' AND jsonb_array_length(detect_roi) = 4)
    );

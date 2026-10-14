-- JOINT5 emits one prediction for an ordered set of five crop images. Preserve
-- that provenance instead of manufacturing five independent OCR predictions.
ALTER TABLE plate_appearances
    ALTER COLUMN agreement_count DROP NOT NULL,
    ADD COLUMN recognition_method varchar(32),
    ADD CONSTRAINT plate_appearances_recognition_method CHECK (
        recognition_method IN ('single_image', 'per_crop_majority', 'joint_multiframe')
    ),
    ADD CONSTRAINT plate_appearances_joint_agreement CHECK (
        recognition_method IS DISTINCT FROM 'joint_multiframe' OR agreement_count IS NULL
    );

ALTER TABLE ocr_predictions
    ALTER COLUMN detection_id DROP NOT NULL,
    ALTER COLUMN input_storage_key DROP NOT NULL,
    ADD COLUMN appearance_id varchar(32) REFERENCES plate_appearances(id) ON DELETE CASCADE,
    ADD COLUMN input_storage_keys jsonb,
    ADD COLUMN frame_weights jsonb,
    ADD CONSTRAINT ocr_predictions_one_parent CHECK (
        (detection_id IS NOT NULL) <> (appearance_id IS NOT NULL)
    ),
    ADD CONSTRAINT ocr_predictions_input_provenance CHECK (
        (detection_id IS NOT NULL AND input_storage_key IS NOT NULL
            AND input_storage_keys IS NULL AND frame_weights IS NULL)
        OR
        (appearance_id IS NOT NULL AND input_storage_key IS NULL
            AND input_storage_keys IS NOT NULL
            AND jsonb_typeof(input_storage_keys) = 'array'
            AND jsonb_array_length(input_storage_keys) = 5)
    ),
    ADD CONSTRAINT ocr_predictions_frame_weights CHECK (
        frame_weights IS NULL OR (
            jsonb_typeof(frame_weights) = 'array' AND jsonb_array_length(frame_weights) = 5
        )
    ),
    ADD CONSTRAINT ocr_predictions_appearance_variant UNIQUE (appearance_id, variant);

CREATE INDEX ocr_predictions_appearance ON ocr_predictions(appearance_id)
    WHERE appearance_id IS NOT NULL;

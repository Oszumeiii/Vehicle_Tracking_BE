-- CTC decoder evidence for one OCR prediction: decoder name, greedy text,
-- plate-format check and heuristic (uncalibrated) beam scores.
ALTER TABLE ocr_predictions
    ADD COLUMN decoding jsonb,
    ADD CONSTRAINT ocr_predictions_decoding_object CHECK (
        decoding IS NULL OR jsonb_typeof(decoding) = 'object'
    );

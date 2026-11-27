-- The readings the OCR decoder weighed besides the one it chose (ocr_predictions.decoding
-- candidates, rank 1 = the next most likely), kept from 2% of the beam's probability.
-- The chosen reading stays the result; these only let match=fuzzy find an unreviewed read
-- whose alternative is the searched plate, rank approximate matches, alert a watchlist
-- ("có thể là") and offer a reviewer the model's other guesses (docs/EVALUATION.md
-- "Tìm kiếm xấp xỉ").
CREATE TABLE plate_candidates (
    appearance_id varchar(32) NOT NULL REFERENCES plate_appearances(id) ON DELETE CASCADE,
    rank smallint NOT NULL CHECK (rank BETWEEN 1 AND 4),
    text varchar(128) NOT NULL CHECK (text ~ '^[A-Z0-9]+$'),
    probability real NOT NULL CHECK (probability BETWEEN 0 AND 1),
    PRIMARY KEY (appearance_id, rank)
);
CREATE INDEX plate_candidates_text ON plate_candidates (text);

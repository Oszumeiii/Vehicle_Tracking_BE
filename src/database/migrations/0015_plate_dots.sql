-- Typed plates were normalized without removing dots, so a watchlist entry "43A-123.45"
-- was stored as 43A123.45 and never matched a read (OCR text has no dots); a review
-- correction typed that way could not be found by search. Store them without dots.
-- An entry that becomes a duplicate (of an undotted one, or of an earlier dotted one) goes.
DELETE FROM plate_watchlist w
WHERE w.plate LIKE '%.%' AND EXISTS (
    SELECT 1 FROM plate_watchlist o
    WHERE o.owner_id = w.owner_id AND o.id <> w.id
      AND replace(o.plate, '.', '') = replace(w.plate, '.', '')
      AND (o.plate NOT LIKE '%.%' OR o.id < w.id)
);
UPDATE plate_watchlist SET plate = replace(plate, '.', '') WHERE plate LIKE '%.%';
UPDATE plate_appearances SET effective_text = replace(effective_text, '.', '')
WHERE effective_text LIKE '%.%' AND review_status = 'corrected';
UPDATE recognition_reviews SET corrected_text = replace(corrected_text, '.', '')
WHERE corrected_text LIKE '%.%';

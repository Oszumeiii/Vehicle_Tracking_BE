-- "Contains" plate searches (LIKE '%ABC%', the Results page default) read every stored
-- read without an index: 357 ms at 2 million reads, 108 ms with this trigram index
-- (docs/EVALUATION.md, "Thử tải"). It answers fragments of three or more characters.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX plate_appearances_effective_trgm ON plate_appearances USING gin (effective_text gin_trgm_ops);

-- Counters of the running stage of a job (frames decoded of expected, tracks read of all...),
-- copied by the worker from the ML side's progress.json at most every 2 s. Null when unknown.
ALTER TABLE recognition_jobs ADD COLUMN progress jsonb;

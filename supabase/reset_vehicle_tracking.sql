-- Paste into Supabase SQL Editor, then run the current initial_schema.sql.
-- Deletes Vehicle Tracking metadata. Never drops Supabase auth/storage system tables.
-- A dependency from an unrelated application aborts and rolls back this transaction.
BEGIN;
DROP POLICY IF EXISTS vehicle_frames_read ON storage.objects;
DROP TABLE IF EXISTS public.crops;
DROP TABLE IF EXISTS public.plate_sightings;
DROP TABLE IF EXISTS public.jobs;
DROP TABLE IF EXISTS public.videos;
DROP TABLE IF EXISTS public.team_members;
DROP TABLE IF EXISTS public.teams;
DO $$
BEGIN
    IF to_regprocedure('vehicle_private.is_team_member(uuid)') IS NOT NULL THEN
        EXECUTE 'DROP FUNCTION vehicle_private.is_team_member(uuid)';
    END IF;
    IF to_regclass('vehicle_private.schema_migrations') IS NOT NULL THEN
        EXECUTE 'DROP TABLE vehicle_private.schema_migrations';
    END IF;
END $$;
COMMIT;

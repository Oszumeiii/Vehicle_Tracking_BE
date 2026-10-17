-- Fresh Vehicle Tracking schema. Supabase supplies auth and storage schemas.
-- All authenticated users share one workspace; keep public sign-up disabled.
CREATE SCHEMA IF NOT EXISTS vehicle_private;
REVOKE ALL ON SCHEMA vehicle_private FROM PUBLIC;

CREATE TABLE public.videos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    filename text NOT NULL,
    node_id text NOT NULL CHECK (length(node_id) > 0),
    local_path text NOT NULL,
    recorded_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.jobs (
    job_id text PRIMARY KEY CHECK (job_id ~ '^[a-f0-9]{32}$'),
    video_id uuid NOT NULL REFERENCES public.videos(id),
    node_id text NOT NULL,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
    model text NOT NULL CHECK (model IN ('yolo11n','yolo11m','yolo11l','yolo26n')),
    confidence double precision NOT NULL CHECK (confidence > 0 AND confidence <= 1),
    input_path text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    selected_frames integer CHECK (selected_frames >= 0),
    total_crops integer CHECK (total_crops >= 0),
    error_code text,
    error_message text,
    CHECK (status NOT IN ('succeeded','failed') OR finished_at IS NOT NULL),
    CHECK (status <> 'succeeded' OR (selected_frames IS NOT NULL AND total_crops IS NOT NULL))
);
CREATE INDEX jobs_queue ON public.jobs(node_id, created_at, job_id) WHERE status='queued';
CREATE INDEX jobs_video ON public.jobs(video_id);
CREATE INDEX jobs_created_at ON public.jobs(created_at DESC);

CREATE TABLE public.plate_sightings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id text NOT NULL REFERENCES public.jobs(job_id) ON DELETE CASCADE,
    track_id text NOT NULL CHECK (length(track_id) > 0),
    plate_raw text,
    plate_normalized text GENERATED ALWAYS AS
        (regexp_replace(upper(plate_raw), '[^A-Z0-9]', '', 'g')) STORED,
    start_seconds double precision NOT NULL CHECK (start_seconds >= 0 AND start_seconds < 'Infinity'::float8),
    end_seconds double precision NOT NULL CHECK (end_seconds >= start_seconds AND end_seconds < 'Infinity'::float8),
    recognition_status text NOT NULL CHECK (recognition_status IN ('predicted','unrecognized','insufficient_frames')),
    prediction jsonb,
    model_version text,
    UNIQUE (job_id, track_id),
    UNIQUE (id, job_id),
    CHECK (recognition_status <> 'predicted' OR (plate_normalized IS NOT NULL AND length(plate_normalized) > 0))
);
CREATE INDEX sightings_plate ON public.plate_sightings(plate_normalized, id);
CREATE TABLE public.crops (
    job_id text NOT NULL,
    crop_id text NOT NULL,
    sighting_id uuid NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal >= 0),
    frame_index integer NOT NULL CHECK (frame_index >= 1),
    timestamp_seconds double precision NOT NULL CHECK (timestamp_seconds >= 0 AND timestamp_seconds < 'Infinity'::float8),
    confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    bbox double precision[] NOT NULL CHECK (array_length(bbox,1) = 4 AND 0 <= ALL(bbox) AND 'Infinity'::float8 > ALL(bbox) AND bbox[3] > bbox[1] AND bbox[4] > bbox[2]),
    crop_bbox integer[] NOT NULL CHECK (array_length(crop_bbox,1) = 4 AND 0 <= ALL(crop_bbox) AND crop_bbox[3] > crop_bbox[1] AND crop_bbox[4] > crop_bbox[2]),
    path text NOT NULL,
    bucket text NOT NULL DEFAULT 'vehicle-frames' CHECK (bucket='vehicle-frames'),
    object_path text NOT NULL CHECK (length(object_path)>0),
    selected_for_ocr boolean NOT NULL DEFAULT false,
    PRIMARY KEY(job_id, crop_id),
    UNIQUE(job_id, ordinal),
    UNIQUE(bucket, object_path),
    FOREIGN KEY (sighting_id, job_id) REFERENCES public.plate_sightings(id, job_id) ON DELETE CASCADE
);
CREATE INDEX crops_sighting ON public.crops(sighting_id);
CREATE INDEX crops_job_order ON public.crops(job_id, ordinal);

ALTER TABLE public.videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plate_sightings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crops ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.videos, public.jobs, public.plate_sightings, public.crops FROM anon, authenticated;
GRANT SELECT ON public.videos, public.jobs, public.plate_sightings, public.crops TO authenticated;
CREATE POLICY videos_read ON public.videos FOR SELECT TO authenticated USING (true);
CREATE POLICY jobs_read ON public.jobs FOR SELECT TO authenticated USING (true);
CREATE POLICY sightings_read ON public.plate_sightings FOR SELECT TO authenticated USING (true);
CREATE POLICY crops_read ON public.crops FOR SELECT TO authenticated USING (true);

INSERT INTO storage.buckets(id,name,public,allowed_mime_types)
VALUES ('vehicle-frames','vehicle-frames',false,ARRAY['image/jpeg'])
ON CONFLICT (id) DO UPDATE SET public=false,allowed_mime_types=EXCLUDED.allowed_mime_types;
CREATE POLICY vehicle_frames_read ON storage.objects FOR SELECT TO authenticated
USING (bucket_id='vehicle-frames' AND EXISTS (
    SELECT 1 FROM public.crops c WHERE c.bucket=bucket_id AND c.object_path=name
));

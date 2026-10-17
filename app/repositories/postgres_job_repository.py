"""PostgreSQL repository for the shared workspace.

User IDs originate from verified Supabase Auth tokens. A private DB credential
is used server-side; authenticated users share access to all workspace data.
"""
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from uuid import UUID
import re

from psycopg.types.json import Jsonb
from app.db.postgres import connect


def normalize_plate(value):
    return re.sub('[^A-Z0-9]', '', value.upper())


def serializable(row):
    if row is None:
        return None
    return {k: v.isoformat() if isinstance(v, datetime) else str(v) if isinstance(v, UUID) else v
            for k, v in row.items()}


class PostgresJobRepository:
    def __init__(self, node_id, user_id=None, connection_factory=connect):
        self.node_id = node_id
        self.user_id = str(UUID(str(user_id))) if user_id else None
        self._connect = connection_factory

    @contextmanager
    def connection(self, write=False):
        # Authentication is performed by the API dependency before constructing
        # a user-scoped repository; the worker constructs one without a user.
        with self._connect() as conn:
            yield conn

    def initialize(self):
        with self.connection() as conn:
            conn.execute('SELECT job_id FROM public.jobs LIMIT 0')

    @contextmanager
    def worker_lock(self):
        # One worker per node/shared filesystem. A session pooler preserves this lock.
        with self._connect() as conn:
            conn.autocommit = True
            key = f'vehicle-worker:{self.node_id}'
            locked = conn.execute('SELECT pg_try_advisory_lock(hashtextextended(%s,0)) AS locked', (key,)).fetchone()['locked']
            if not locked:
                raise RuntimeError('Another worker owns this node.')
            try:
                yield
            finally:
                conn.execute('SELECT pg_advisory_unlock(hashtextextended(%s,0))', (key,))

    def create(self, job_id, model, confidence, input_path):
        with self.connection(write=True) as conn:
            video = conn.execute('''INSERT INTO public.videos(created_by,filename,node_id,local_path)
                         VALUES(%s,%s,%s,%s) RETURNING id''',
                         (self.user_id,Path(input_path).name,self.node_id,str(input_path))).fetchone()['id']
            conn.execute('''INSERT INTO public.jobs(job_id,video_id,node_id,model,confidence,input_path)
                         VALUES(%s,%s,%s,%s,%s,%s)''',
                         (job_id,video,self.node_id,model,confidence,str(input_path)))

    def get(self, job_id):
        with self.connection() as conn:
            return serializable(conn.execute('SELECT * FROM public.jobs WHERE job_id=%s',
                                             (job_id,)).fetchone())

    def claim(self):
        with self.connection(write=True) as conn:
            row = conn.execute('''SELECT job_id FROM public.jobs WHERE node_id=%s AND status='queued'
                              ORDER BY created_at,job_id FOR UPDATE SKIP LOCKED LIMIT 1''',
                              (self.node_id,)).fetchone()
            if not row:
                return None
            return serializable(conn.execute("UPDATE public.jobs SET status='running',started_at=now() WHERE job_id=%s RETURNING *",
                                             (row['job_id'],)).fetchone())

    def recover(self):
        # Only invoke after acquiring worker_lock, never during API startup.
        with self.connection(write=True) as conn:
            conn.execute("""UPDATE public.jobs SET status='failed',finished_at=now(),error_code='WORKER_INTERRUPTED',
                         error_message='Worker stopped before the job completed.'
                         WHERE node_id=%s AND status='running'""", (self.node_id,))

    def fail(self, job_id, code, message):
        with self.connection(write=True) as conn:
            conn.execute("""UPDATE public.jobs SET status='failed',finished_at=now(),error_code=%s,error_message=%s
                         WHERE node_id=%s AND job_id=%s AND status='running'""",
                         (code,message,self.node_id,job_id))

    def succeed(self, job_id, selected_frames, crops):
        with self.connection(write=True) as conn:
            job = conn.execute('SELECT status FROM public.jobs WHERE node_id=%s AND job_id=%s FOR UPDATE',
                               (self.node_id,job_id)).fetchone()
            if not job or job['status'] != 'running':
                raise ValueError('Job is not running on this node.')
            groups = {}
            for crop in crops:
                groups.setdefault(crop['track_id'], []).append(crop)
            for track_id, items in groups.items():
                summary = items[0]['track_summary']
                prediction = summary.get('prediction') or {}
                sighting = conn.execute('''INSERT INTO public.plate_sightings
                    (job_id,track_id,plate_raw,start_seconds,end_seconds,recognition_status,prediction,model_version)
                    VALUES(%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id''',
                    (job_id,track_id,prediction.get('text'),min(c['timestamp_seconds'] for c in items),
                     max(c['timestamp_seconds'] for c in items),summary['status'],Jsonb(prediction),prediction.get('model_id'))).fetchone()['id']
                for item in items:
                    item['sighting_id'] = sighting
            for i, item in enumerate(crops):
                conn.execute('''INSERT INTO public.crops
                    (job_id,crop_id,sighting_id,ordinal,frame_index,timestamp_seconds,confidence,bbox,crop_bbox,path,bucket,object_path,selected_for_ocr)
                    VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                    (job_id,item['crop_id'],item['sighting_id'],i,item['frame_index'],item['timestamp_seconds'],
                     item['confidence'],item['bbox'],item['crop_bbox'],item['path'],item['bucket'],item['object_path'],
                     item['frame_index'] in item['track_summary'].get('selected_frame_indices', [])))
            conn.execute("""UPDATE public.jobs SET status='succeeded',finished_at=now(),selected_frames=%s,total_crops=%s
                         WHERE job_id=%s""", (selected_frames,len(crops),job_id))

    def plates(self, job_id, limit, offset):
        with self.connection() as conn:
            return [dict(r) for r in conn.execute('''SELECT * FROM public.crops WHERE job_id=%s
                                                  ORDER BY ordinal LIMIT %s OFFSET %s''', (job_id,limit,offset)).fetchall()]

    def crop(self, job_id, crop_id):
        with self.connection() as conn:
            return conn.execute('SELECT * FROM public.crops WHERE job_id=%s AND crop_id=%s',
                                (job_id,crop_id)).fetchone()

    def artifacts(self, job_id):
        with self.connection(write=True) as conn:
            return conn.execute('SELECT bucket,object_path FROM public.crops WHERE job_id=%s',
                                (job_id,)).fetchall()

    def delete(self, job_id):
        with self.connection(write=True) as conn:
            row = conn.execute("""DELETE FROM public.jobs WHERE job_id=%s
                                 AND status IN ('succeeded','failed') RETURNING video_id""", (job_id,)).fetchone()
            if row:
                conn.execute('''DELETE FROM public.videos v WHERE id=%s AND NOT EXISTS
                             (SELECT 1 FROM public.jobs j WHERE j.video_id=v.id)''', (row['video_id'],))

    def search(self, plate, limit, offset):
        normalized = normalize_plate(plate)
        if not normalized:
            raise ValueError('Plate must contain letters or numbers.')
        with self.connection() as conn:
            return [serializable(r) for r in conn.execute('''SELECT s.*,j.video_id FROM public.plate_sightings s
                JOIN public.jobs j ON j.job_id=s.job_id WHERE s.plate_normalized=%s
                AND j.status='succeeded' ORDER BY s.id LIMIT %s OFFSET %s''',
                (normalized,limit,offset)).fetchall()]

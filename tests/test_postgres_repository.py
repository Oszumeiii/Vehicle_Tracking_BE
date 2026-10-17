"""Real PostgreSQL tests in an empty disposable DB, never the shared dev DB."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import os
from uuid import uuid4
import json

import psycopg
from psycopg.rows import dict_row
import pytest

from scripts.migrate_db import migrate
from app.repositories.postgres_job_repository import PostgresJobRepository


@pytest.fixture(scope='module')
def db_connect():
    dsn = os.getenv('VEHICLE_TEST_PG_DSN')
    if not dsn:
        pytest.skip('Set VEHICLE_TEST_PG_DSN to an empty disposable PostgreSQL database.')
    def connect():
        return psycopg.connect(dsn, row_factory=dict_row)
    with connect() as conn:
        assert conn.execute("SELECT to_regclass('public.jobs') AS t").fetchone()['t'] is None
        assert conn.execute("SELECT to_regclass('auth.users') AS t").fetchone()['t'] is None
        conn.execute('''DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
            END $$;
            CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
            CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
            $$ SELECT nullif(current_setting('request.jwt.claims',true)::jsonb->>'sub','')::uuid $$;
            CREATE SCHEMA storage;
            CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,allowed_mime_types text[]);
            CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text);
            ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
            GRANT USAGE ON SCHEMA storage TO authenticated;
            GRANT SELECT ON storage.objects TO authenticated;''')
    assert len(migrate(connect)) == 1
    assert migrate(connect) == []
    with connect() as conn:
        assert conn.execute("SELECT to_regclass('public.teams') AS t").fetchone()['t'] is None
        assert conn.execute("SELECT to_regclass('public.team_members') AS t").fetchone()['t'] is None
        for table in ('videos','jobs','plate_sightings','crops'):
            assert conn.execute('''SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name=%s AND column_name='team_id' ''',(table,)).fetchone() is None
    yield connect


@pytest.fixture
def repo(db_connect):
    return PostgresJobRepository('node-a',connection_factory=db_connect)


def crop(job_id, track='1'):
    return dict(crop_id='00000001',track_id=track,frame_index=1,timestamp_seconds=1.5,
                confidence=0.9,bbox=[1.,2.,30.,40.],crop_bbox=[0,0,32,42],path='runs/a/crops/1.jpg',
                bucket='vehicle-frames',object_path=f'{job_id}/00000001.jpg',
                track_summary={'status':'predicted','prediction':{'text':'30a-123.45','model_id':'test'},
                               'selected_frame_indices':[1]})


def test_lifecycle_search_and_delete(repo):
    repo.initialize()
    job = uuid4().hex
    repo.create(job,'yolo11m',0.25,'/tmp/video.mp4')
    assert repo.get(job)['status'] == 'queued'
    assert repo.claim()['job_id'] == job
    repo.succeed(job,5,[crop(job)])
    assert repo.get(job)['status'] == 'succeeded'
    assert len(repo.search('30A 12345',50,0)) == 1
    assert repo.plates(job,1,0)[0]['selected_for_ocr'] is True
    assert repo.crop(job,'00000001')['bucket'] == 'vehicle-frames'
    with pytest.raises(ValueError):
        repo.succeed(job,5,[crop(job)])
    repo.delete(job)
    assert repo.get(job) is None
    assert repo.search('30A12345',50,0) == []


def test_transaction_rolls_back_all_results(repo):
    job = uuid4().hex
    repo.create(job,'yolo11n',0.25,'/tmp/input.mp4')
    repo.claim()
    first = crop(job)
    second = dict(first, track_id='2')
    with pytest.raises(psycopg.errors.UniqueViolation):
        repo.succeed(job,5,[first,second])
    assert repo.get(job)['status'] == 'running'
    assert repo.plates(job,50,0) == []
    assert repo.search('30A12345',50,0) == []
    with repo.connection() as conn:
        assert conn.execute('SELECT count(*) AS n FROM public.plate_sightings WHERE job_id=%s',(job,)).fetchone()['n'] == 0


def test_parallel_claim_and_node_recovery(repo, db_connect):
    jobs = [uuid4().hex for _ in range(4)]
    for job in jobs:
        repo.create(job,'yolo11n',0.25,'/tmp/input.mp4')
    other = PostgresJobRepository('node-b',connection_factory=db_connect)
    other_job = uuid4().hex
    other.create(other_job,'yolo11n',0.25,'/tmp/other.mp4')
    assert other.claim()['job_id'] == other_job
    with ThreadPoolExecutor(max_workers=4) as pool:
        claimed = list(pool.map(lambda _: repo.claim()['job_id'],jobs))
    assert set(claimed) == set(jobs)
    assert repo.claim() is None
    with repo.worker_lock():
        with pytest.raises(RuntimeError,match='Another worker'):
            with repo.worker_lock():
                pass
        repo.recover()
    assert all(repo.get(j)['status'] == 'failed' for j in jobs)
    assert other.get(other_job)['status'] == 'running'


def test_sighting_requires_text_when_predicted(repo):
    job = uuid4().hex
    repo.create(job,'yolo11m',0.25,'/tmp/input.mp4')
    repo.claim()
    item = crop(job)
    item['track_summary']['prediction'] = {}
    with pytest.raises(psycopg.errors.CheckViolation):
        repo.succeed(job,5,[item])
    assert repo.get(job)['status'] == 'running'


def test_worker_imports_track_predictions_and_uploads_crops(repo, tmp_path):
    import csv
    import sys
    from pathlib import Path
    from unittest.mock import Mock
    from app.core.config import Settings
    from app.services.plate_job_service import JobService
    from app.workers.job_executor import process_one
    service = JobService(Settings(tmp_path,tmp_path,Path(sys.executable),
                                db_backend='supabase',node_id='node-a'))
    service.repo = repo
    service.storage = Mock(bucket='vehicle-frames')
    job = uuid4().hex
    folder = service.job_dir(job)
    folder.mkdir(parents=True)
    repo.create(job,'yolo11m',0.25,folder/'input.mp4')

    def runner(settings, job_data, job_folder):
        run = job_folder/'runs'/'test'
        run.mkdir(parents=True)
        (run/'crop.jpg').write_bytes(b'jpeg-test')
        (run/'report.json').write_text(json.dumps({
            'status':'complete','frame_count':1,
            'models':{'yolo11m':{'status':'complete','total_detections':1}},
            'tracks':[{'track_id':'7','status':'predicted','selected_frame_indices':[1],
                       'prediction':{'text':'30A12345','model_id':'test'}}],
        }))
        row = dict(model='yolo11m',track_id='7',crop_path='crop.jpg',frame_index=1,
                   timestamp_seconds=0.5,confidence=0.9,x1=1,y1=2,x2=30,y2=40,
                   crop_x1=0,crop_y1=0,crop_x2=32,crop_y2=42)
        with (run/'ocr_crop_manifest.csv').open('w',newline='') as output:
            writer = csv.DictWriter(output,fieldnames=list(row))
            writer.writeheader()
            writer.writerow(row)
        return {'run_dir':str(run),'selected_frames':1}

    assert process_one(service, runner)
    assert repo.get(job)['status'] == 'succeeded'
    assert repo.search('30A-123.45',10,0)[0]['track_id'] == '7'
    row = repo.crop(job,'00000001')
    assert row['selected_for_ocr'] is True
    service.storage.upload.assert_called_once_with(
        f'{job}/00000001.jpg',folder/'runs'/'test'/'crop.jpg')


@contextmanager
def authenticated(connect, user):
    with connect() as conn:
        conn.execute('SET LOCAL ROLE authenticated')
        conn.execute("SELECT set_config('request.jwt.claims',%s,true)",(json.dumps({'sub':str(user)}),))
        yield conn


def test_rls_all_signed_in_users_share_read_access(repo, db_connect):
    users = [uuid4(),uuid4()]
    with db_connect() as conn:
        conn.execute('INSERT INTO auth.users(id) VALUES(%s),(%s)',tuple(users))
    job = uuid4().hex
    repo.create(job,'yolo11m',0.25,'/tmp/input.mp4')
    repo.claim()
    repo.succeed(job,5,[crop(job)])
    with db_connect() as conn:
        conn.execute("INSERT INTO storage.objects(bucket_id,name) VALUES('vehicle-frames',%s)",(crop(job)['object_path'],))
    for user in users:
        with authenticated(db_connect,user) as conn:
            assert conn.execute('SELECT job_id FROM public.jobs WHERE job_id=%s',(job,)).fetchone()
            assert conn.execute('SELECT * FROM storage.objects WHERE name=%s',(crop(job)['object_path'],)).fetchone()
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with authenticated(db_connect,users[0]) as conn:
            conn.execute("UPDATE public.jobs SET status='running' WHERE job_id=%s",(job,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with db_connect() as conn:
            conn.execute('SET LOCAL ROLE anon')
            conn.execute('SELECT * FROM public.jobs')

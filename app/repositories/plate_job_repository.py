from contextlib import contextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3


def now():
    return datetime.now(timezone.utc).isoformat()


class JobRepository:
    def __init__(self, path: Path):
        self.path = path

    @contextmanager
    def connection(self):
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def initialize(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS jobs (
                    job_id TEXT PRIMARY KEY, status TEXT NOT NULL,
                    model TEXT NOT NULL, confidence REAL NOT NULL,
                    input_path TEXT NOT NULL, created_at TEXT NOT NULL,
                    started_at TEXT, finished_at TEXT,
                    selected_frames INTEGER, total_crops INTEGER,
                    error_code TEXT, error_message TEXT
                );
                CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, created_at);
                CREATE TABLE IF NOT EXISTS crops (
                    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
                    crop_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
                    frame_index INTEGER NOT NULL, timestamp_seconds REAL NOT NULL,
                    confidence REAL NOT NULL, bbox TEXT NOT NULL,
                    crop_bbox TEXT NOT NULL, path TEXT NOT NULL,
                    PRIMARY KEY(job_id, crop_id)
                );
                CREATE INDEX IF NOT EXISTS crops_order ON crops(job_id, ordinal);
            """)

    def create(self, job_id, model, confidence, input_path):
        with self.connection() as conn:
            conn.execute("INSERT INTO jobs(job_id,status,model,confidence,input_path,created_at) VALUES(?,?,?,?,?,?)",
                         (job_id, "queued", model, confidence, str(input_path), now()))

    def get(self, job_id):
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
            return dict(row) if row else None

    def claim(self):
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at,job_id LIMIT 1").fetchone()
            if row is None:
                return None
            conn.execute("UPDATE jobs SET status='running',started_at=? WHERE job_id=?", (now(), row["job_id"]))
            return dict(conn.execute("SELECT * FROM jobs WHERE job_id=?", (row["job_id"],)).fetchone())

    def recover(self):
        with self.connection() as conn:
            conn.execute("""UPDATE jobs SET status='failed',finished_at=?,error_code='WORKER_INTERRUPTED',
                         error_message='Worker stopped before the job completed.' WHERE status='running'""", (now(),))

    def fail(self, job_id, code, message):
        with self.connection() as conn:
            conn.execute("UPDATE jobs SET status='failed',finished_at=?,error_code=?,error_message=? WHERE job_id=? AND status='running'",
                         (now(), code, message, job_id))

    def succeed(self, job_id, selected_frames, crops):
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if conn.execute("SELECT status FROM jobs WHERE job_id=?", (job_id,)).fetchone()[0] != "running":
                raise ValueError("Job is not running")
            conn.executemany("INSERT INTO crops VALUES(?,?,?,?,?,?,?,?,?)", [
                (job_id, item["crop_id"], i, item["frame_index"], item["timestamp_seconds"],
                 item["confidence"], json.dumps(item["bbox"]), json.dumps(item["crop_bbox"]), item["path"])
                for i, item in enumerate(crops)
            ])
            conn.execute("UPDATE jobs SET status='succeeded',finished_at=?,selected_frames=?,total_crops=? WHERE job_id=?",
                         (now(), selected_frames, len(crops), job_id))

    def plates(self, job_id, limit, offset):
        with self.connection() as conn:
            rows = conn.execute("SELECT * FROM crops WHERE job_id=? ORDER BY ordinal LIMIT ? OFFSET ?",
                                (job_id, limit, offset)).fetchall()
            return [{**dict(row), "bbox": json.loads(row["bbox"]), "crop_bbox": json.loads(row["crop_bbox"])} for row in rows]

    def crop(self, job_id, crop_id):
        with self.connection() as conn:
            row = conn.execute("SELECT path FROM crops WHERE job_id=? AND crop_id=?", (job_id, crop_id)).fetchone()
            return row["path"] if row else None

    def delete(self, job_id):
        with self.connection() as conn:
            conn.execute("DELETE FROM jobs WHERE job_id=? AND status IN ('succeeded','failed')", (job_id,))

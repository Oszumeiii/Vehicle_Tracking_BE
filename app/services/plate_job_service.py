from pathlib import Path
import shutil
import uuid
import json
from fastapi import HTTPException, UploadFile
from app.core.config import Settings
from app.repositories.plate_job_repository import JobRepository


def safe_path(root: Path, relative: str) -> Path:
    relative = relative.replace("\\", "/")
    if not relative or ":" in relative or Path(relative).is_absolute() or ".." in Path(relative).parts:
        raise ValueError("Invalid artifact path")
    root = root.resolve()
    path = (root / relative).resolve()
    if path == root or not path.is_relative_to(root):
        raise ValueError("Artifact outside job directory")
    return path


class JobService:
    def __init__(self, settings: Settings, user_id=None):
        self.settings = settings
        self.storage = None
        if settings.db_backend == "supabase":
            from app.repositories.postgres_job_repository import PostgresJobRepository
            from app.services.supabase_storage import CropStorage
            self.repo = PostgresJobRepository(settings.node_id, user_id)
            self.storage = CropStorage()
        else:
            self.repo = JobRepository(settings.db_path)

    def job_dir(self, job_id):
        return safe_path(self.settings.data_dir / "jobs", job_id)

    def upload(self, file: UploadFile, model: str):
        folder = None
        created = False
        try:
            suffix = Path(file.filename or "").suffix.lower()
            if suffix not in (".mp4", ".avi", ".mov"):
                raise HTTPException(415, "Supported formats: MP4, AVI, MOV.")
            job_id = uuid.uuid4().hex
            folder = self.job_dir(job_id)
            folder.mkdir(parents=True, exist_ok=False)
            created = True
            temporary = folder / "upload.part"
            size = 0
            with temporary.open("wb") as output:
                while chunk := file.file.read(1024 * 1024):
                    size += len(chunk)
                    if size > self.settings.max_upload_bytes:
                        raise HTTPException(413, "Video exceeds the upload limit.")
                    output.write(chunk)
            if size == 0:
                raise HTTPException(422, "Video is empty.")
            destination = folder / f"input{suffix}"
            temporary.replace(destination)
            self.repo.create(
                job_id,
                model,
                self.settings.detection_confidence,
                destination,
            )
            return {"job_id": job_id, "status": "queued", "status_url": f"/api/v1/plate-jobs/{job_id}"}
        except BaseException:
            if created and folder is not None:
                shutil.rmtree(folder)
            raise
        finally:
            file.file.close()
            
            
            
            
            
            
            
            
            
            
            
            
            
            
            

    def get(self, job_id, ready=False):
        job = self.repo.get(job_id)
        if job is None:
            raise HTTPException(404, "Job not found.")
        if ready and job["status"] != "succeeded":
            raise HTTPException(409, "Results are available only for succeeded jobs.")
        return job

    def plates(self, job_id, limit, offset):
        job = self.get(job_id, ready=True)
        rows = self.repo.plates(job_id, limit, offset)
        return {"job_id": job_id, "total": job["total_crops"], "limit": limit, "offset": offset,
                "items": [{**row, "crop_url": f"/api/v1/plate-jobs/{job_id}/crops/{row['crop_id']}"} for row in rows]}

    def crop(self, job_id, crop_id):
        self.get(job_id, ready=True)
        relative = self.repo.crop(job_id, crop_id)
        try:
            path = safe_path(self.job_dir(job_id), relative) if relative else None
        except ValueError:
            path = None
        if path is None or not path.is_file():
            raise HTTPException(404, "Crop not found.")
        return path

    def delete(self, job_id):
        job = self.get(job_id)
        if job["status"] not in ("succeeded", "failed"):
            raise HTTPException(409, "Queued or running jobs cannot be deleted.")
        if self.storage:
            if job["node_id"] != self.settings.node_id:
                raise HTTPException(409, "Delete this job through its source node API.")
            artifacts = self.repo.artifacts(job_id)  # Checks write permission before side effects.
            paths = {r["object_path"] for r in artifacts}
            journal = self.job_dir(job_id) / "storage-uploads.json"
            if journal.exists():
                prefix = f"{job_id}/"
                for path in json.loads(journal.read_text(encoding="utf-8")):
                    if not isinstance(path, str) or not path.startswith(prefix) or ".." in path:
                        raise ValueError("Invalid upload journal")
                    paths.add(path)
            self.storage.remove(sorted(paths))
        folder = self.job_dir(job_id)
        if folder.exists():
            shutil.rmtree(folder)
        self.repo.delete(job_id)

    def crop_url(self, job_id, crop_id):
        self.get(job_id, ready=True)
        row = self.repo.crop(job_id, crop_id)
        if row is None:
            raise HTTPException(404, "Crop not found.")
        return self.storage.signed_url(row["object_path"])

    def complete(self, job_id, frame_count, crops):
        if not self.storage:
            return self.repo.succeed(job_id, frame_count, crops)
        folder = self.job_dir(job_id)
        # Paths are stable within a job. Failed uploads may have succeeded remotely,
        # so record the attempted path before sending the request.
        attempted = []
        planned = [f"{job_id}/{c['crop_id']}.jpg" for c in crops]
        (folder / "storage-uploads.json").write_text(json.dumps(planned), encoding="utf-8")
        try:
            for crop in crops:
                if not crop.get("track_id") or not crop.get("track_summary"):
                    raise ValueError("Missing track metadata in pipeline results.")
                path = f"{job_id}/{crop['crop_id']}.jpg"
                attempted.append(path)
                self.storage.upload(path, safe_path(folder, crop["path"]))
                crop.update(bucket=self.storage.bucket, object_path=path)
        except Exception:
            self.storage.remove(attempted)
            raise
        # A DB commit error may mean commit succeeded but acknowledgement was lost.
        # Keep uploaded files on ambiguous failure; cleanup can reconcile later.
        self.repo.succeed(job_id, frame_count, crops)

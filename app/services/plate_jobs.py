from pathlib import Path
import shutil
import uuid
from fastapi import HTTPException, UploadFile
from app.core.config import Settings
from app.repositories.plate_jobs import JobRepository


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
    def __init__(self, settings: Settings):
        self.settings = settings
        self.repo = JobRepository(settings.db_path)

    def job_dir(self, job_id):
        return safe_path(self.settings.data_dir / "jobs", job_id)

    def upload(self, file: UploadFile, model: str, confidence: float):
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
            self.repo.create(job_id, model, confidence, destination)
            return {"job_id": job_id, "status": "queued", "status_url": f"/api/v1/plate-jobs/{job_id}"}
        except BaseException:
            if created:
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
        folder = self.job_dir(job_id)
        if folder.exists():
            shutil.rmtree(folder)
        self.repo.delete(job_id)

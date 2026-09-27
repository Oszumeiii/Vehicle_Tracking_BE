from typing import Annotated
from fastapi import APIRouter, Depends, File, Form, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response
from app.schemas.plate_jobs import AcceptedJob, JobStatus, ModelName, PlatePage
from app.services.plate_jobs import JobService

router = APIRouter(prefix="/api/v1/plate-jobs", tags=["plate-jobs"])


def service(request: Request) -> JobService:
    return request.app.state.jobs


Service = Annotated[JobService, Depends(service)]


@router.post("", status_code=202, response_model=AcceptedJob,
             responses={413: {"description": "Upload too large"}, 415: {"description": "Unsupported video format"}},
             summary="Upload a video and queue plate extraction")
def create_job(jobs: Service, file: Annotated[UploadFile, File()],
               model: Annotated[ModelName, Form()] = "yolov8",
               confidence: Annotated[float, Form(gt=0, le=1, allow_inf_nan=False)] = 0.25):
    return jobs.upload(file, model, confidence)


@router.get("/{job_id}", response_model=JobStatus, summary="Poll job status (every two seconds)")
def get_job(job_id: str, jobs: Service):
    return jobs.get(job_id)


@router.get("/{job_id}/plates", response_model=PlatePage, summary="List completed plate crops")
def list_plates(job_id: str, jobs: Service, limit: Annotated[int, Query(ge=1, le=200)] = 50,
                offset: Annotated[int, Query(ge=0)] = 0):
    return jobs.plates(job_id, limit, offset)


@router.get("/{job_id}/crops/{crop_id}", response_class=FileResponse,
            responses={200: {"content": {"image/jpeg": {}}}}, summary="View a plate crop")
def get_crop(job_id: str, crop_id: str, jobs: Service):
    return FileResponse(jobs.crop(job_id, crop_id), media_type="image/jpeg")


@router.delete("/{job_id}", status_code=204, summary="Delete a finished job and its files")
def delete_job(job_id: str, jobs: Service):
    jobs.delete(job_id)
    return Response(status_code=204)

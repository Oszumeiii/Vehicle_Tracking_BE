from fastapi import Request

from app.services.plate_job_service import JobService


def get_job_service(request: Request) -> JobService:
    return request.app.state.jobs

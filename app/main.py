from contextlib import asynccontextmanager
import threading

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from app.core.config import Settings
from app.core.upload_limit import UploadLimitMiddleware
from app.api.v1.router import router as api_router
from app.services.plate_job_service import JobService


def create_app(settings: Settings | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application):
        jobs = JobService(settings or Settings.from_env())
        jobs.repo.initialize()
        application.state.jobs = jobs
        yield

    application = FastAPI(title="Vehicle Tracking API", version="0.3.0", lifespan=lifespan,
                          description="Video plate extraction jobs and five-frame plate recognition.")
    application.state.inference_model = None
    application.state.inference_device = None
    application.state.inference_config = None
    application.state.inference_lock = threading.Lock()
    application.include_router(api_router)
    @application.exception_handler(PermissionError)
    async def permission_denied(request, exc):
        return JSONResponse(status_code=403, content={"detail": "Access denied."})
    application.add_middleware(UploadLimitMiddleware)

    @application.get("/")
    def root():
        return {"message": "Vehicle Tracking API is running"}

    return application


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=True)

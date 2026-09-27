from contextlib import asynccontextmanager
from fastapi import FastAPI
from app.core.config import Settings
from app.core.upload_limit import UploadLimitMiddleware
from app.routers.health import router as health_router
from app.routers.plate_jobs import router as plate_jobs_router
from app.services.plate_jobs import JobService


def create_app(settings: Settings | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application):
        jobs = JobService(settings or Settings.from_env())
        jobs.repo.initialize()
        application.state.jobs = jobs
        yield

    application = FastAPI(title="Vehicle Tracking API", version="0.2.0", lifespan=lifespan,
                          description="Upload video, poll plate extraction jobs, and view plate crops. No OCR or tracking.")
    application.include_router(health_router)
    application.include_router(plate_jobs_router)
    application.add_middleware(UploadLimitMiddleware)

    @application.get("/")
    def root():
        return {"message": "Vehicle Tracking API is running"}

    return application


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)

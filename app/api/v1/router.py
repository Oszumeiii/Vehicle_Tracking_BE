from fastapi import APIRouter

from app.api.v1.endpoints.health import router as health_router
from app.api.v1.endpoints.plate_jobs import router as plate_jobs_router
from app.api.v1.endpoints.recognition import router as recognition_router


router = APIRouter()
router.include_router(health_router)
router.include_router(plate_jobs_router)
router.include_router(recognition_router)

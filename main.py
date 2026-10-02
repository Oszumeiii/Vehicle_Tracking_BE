from contextlib import asynccontextmanager
import logging
import threading

from fastapi import APIRouter, FastAPI, File, HTTPException, Request, UploadFile
from app.core.config import Settings
from app.core.upload_limit import UploadLimitMiddleware
from app.routers.health import router as health_router
from app.routers.plate_jobs import router as plate_jobs_router
from app.services.plate_jobs import JobService


logger = logging.getLogger(__name__)
model_router = APIRouter(prefix="/api/v1/model", tags=["model-inference"])


def _get_model_runtime(application: FastAPI):
    if application.state.inference_model is not None:
        return (
            application.state.inference_model,
            application.state.inference_device,
            application.state.inference_config,
        )

    with application.state.inference_lock:
        if application.state.inference_model is not None:
            return (
                application.state.inference_model,
                application.state.inference_device,
                application.state.inference_config,
            )

        try:
            import torch

            from app.models.config import Config as ModelConfig
            from app.models.model import load_model

            device = torch.device(ModelConfig.DEVICE)
            if device.type == "cuda" and not torch.cuda.is_available():
                raise RuntimeError("MODEL_DEVICE is cuda, but CUDA is not available")
            if not ModelConfig.CHECKPOINT_PATH.exists():
                raise FileNotFoundError(f"Model checkpoint not found: {ModelConfig.CHECKPOINT_PATH}")
            model = load_model(ModelConfig.CHECKPOINT_PATH, device)
        except Exception as exc:
            logger.exception("Could not load the inference model")
            raise HTTPException(
                status_code=503,
                detail="Model inference is unavailable; verify ML dependencies and MODEL_CHECKPOINT.",
            ) from exc

        application.state.inference_model = model
        application.state.inference_device = device
        application.state.inference_config = ModelConfig
        return model, device, ModelConfig


@model_router.get("/health")
def model_health(request: Request):
    return {"status": "ok", "model_loaded": request.app.state.inference_model is not None}


@model_router.post("/predict")
def predict_model(request: Request, frames: list[UploadFile] = File(...)):
    model, device, model_config = _get_model_runtime(request.app)
    if len(frames) != model_config.NUM_FRAMES:
        raise HTTPException(
            status_code=422,
            detail=f"Exactly {model_config.NUM_FRAMES} frames are required.",
        )

    import torch

    from app.models.decoder import decode_constrained
    from app.models.preprocessing import preprocess_image

    tensors = []
    for index, frame in enumerate(frames, start=1):
        image_bytes = frame.file.read(model_config.MAX_FRAME_BYTES + 1)
        if len(image_bytes) > model_config.MAX_FRAME_BYTES:
            raise HTTPException(status_code=413, detail=f"Frame {index} exceeds the size limit.")
        try:
            tensors.append(preprocess_image(image_bytes))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=f"Frame {index}: {exc}") from exc

    batch = torch.stack(tensors).unsqueeze(0).to(device)
    with torch.inference_mode():
        logits, _, _, _, frame_weights = model(batch)
    text, _, valid = decode_constrained(logits, model_config.IDX2CHAR)
    if not valid:
        raise HTTPException(status_code=500, detail="No candidate matched the configured plate format.")

    return {
        "text": text,
        "frame_weights": frame_weights[0].float().cpu().tolist(),
    }


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
    application.include_router(health_router)
    application.include_router(plate_jobs_router)
    application.include_router(model_router)
    application.add_middleware(UploadLimitMiddleware)

    @application.get("/")
    def root():
        return {"message": "Vehicle Tracking API is running"}

    return application


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)

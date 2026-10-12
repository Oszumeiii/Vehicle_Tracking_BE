import logging

from fastapi import APIRouter, FastAPI, File, HTTPException, Request, UploadFile

from app.ai.recognition.config import Config as ModelConfig


logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/model", tags=["model-inference"])


def get_model_runtime(application: FastAPI):
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

            from app.ai.recognition.model import load_model

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


@router.get("/health")
def model_health(request: Request):
    return {"status": "ok", "model_loaded": request.app.state.inference_model is not None}


@router.post("/predict")
def predict_model(request: Request, frames: list[UploadFile] = File(...)):
    model, device, model_config = get_model_runtime(request.app)
    if len(frames) != model_config.NUM_FRAMES:
        raise HTTPException(
            status_code=422,
            detail=f"Exactly {model_config.NUM_FRAMES} frames are required.",
        )

    import torch

    from app.ai.recognition.decoder import decode_constrained
    from app.ai.recognition.preprocessing import preprocess_image

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
        logits, frame_weights = model(batch, return_aux=False, return_weights=True)
    text, _, valid = decode_constrained(logits, model_config.IDX2CHAR)
    if not valid:
        raise HTTPException(status_code=500, detail="No candidate matched the configured plate format.")

    return {
        "text": text,
        "frame_weights": frame_weights[0].float().cpu().tolist(),
    }

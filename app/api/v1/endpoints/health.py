from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/health", summary="Check API health")
async def health_check() -> dict[str, str]:
    return {"status": "ok"}
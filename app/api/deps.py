from fastapi import Request, HTTPException

from app.services.plate_job_service import JobService


def get_job_service(request: Request) -> JobService:
    service = request.app.state.jobs
    if service.settings.db_backend == "sqlite":
        return service
    from app.db.supabase import get_supabase
    from supabase_auth.errors import AuthApiError
    import httpx
    header = request.headers.get("Authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(401, "Supabase access token required.", headers={"WWW-Authenticate":"Bearer"})
    try:
        user = get_supabase().auth.get_user(token.strip()).user
    except AuthApiError:
        raise HTTPException(401, "Invalid or expired access token.") from None
    except httpx.HTTPError:
        raise HTTPException(503, "Authentication service unavailable.") from None
    if user is None:
        raise HTTPException(401, "Invalid access token.")
    scoped = JobService(service.settings, user_id=user.id)
    with scoped.repo.connection():
        pass
    return scoped

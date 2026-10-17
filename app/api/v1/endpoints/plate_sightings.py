from typing import Annotated
from fastapi import APIRouter, Depends, HTTPException, Query
from app.api.deps import get_job_service
from app.services.plate_job_service import JobService

router = APIRouter(prefix='/api/v1/plate-sightings', tags=['plate-sightings'])


@router.get('')
def search(jobs: Annotated[JobService, Depends(get_job_service)],
           plate: Annotated[str, Query(min_length=1, max_length=32)],
           limit: Annotated[int, Query(ge=1, le=200)] = 50,
           offset: Annotated[int, Query(ge=0)] = 0):
    if jobs.settings.db_backend != 'supabase':
        raise HTTPException(409, 'Plate search requires the Supabase backend.')
    try:
        return {'items': jobs.repo.search(plate,limit,offset), 'limit':limit, 'offset':offset}
    except ValueError:
        raise HTTPException(422, 'Plate must contain letters or numbers.') from None

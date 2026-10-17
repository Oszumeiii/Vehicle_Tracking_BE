---
name: vehicle-tracking-backend
description: Develop and debug Vehicle_Tracking_BE FastAPI endpoints, video plate detection/tracking/OCR, plate search, and Supabase PostgreSQL/Storage integration. Use for work inside this repository, not unrelated FastAPI or Supabase projects.
---

# Vehicle Tracking Backend

Work from the repository root. Explain changes and verification in Vietnamese unless the user requests another language. Implement only the requested feature; the Supabase direction below is not a request to migrate the whole application on every invocation.

## Establish current state

Read `README.md`, relevant code and tests, and `git status --short`. Code is authoritative when documentation differs. Preserve user edits. Inspect configuration declarations or `.env.example` when present; do not dump `.env`, credentials, connection strings, or signed URLs into output.

Repository map:
- `app/api/v1/endpoints/`: HTTP contracts; `app/schemas/`: request/response models.
- `app/services/plate_job_service.py`: upload and job lifecycle.
- `app/repositories/plate_job_repository.py`: persistence and job claiming.
- `app/workers/job_executor.py`: execution, manifest validation and result import.
- `app/ai/pipelines/video_pipeline.py`: sampling, detection, tracking, crop selection and per-track prediction.
- `app/ai/recognition/`: model, preprocessing, decoder and five-frame inference.
- `app/core/config.py`, `app/ai/recognition/config.py`: actual configuration defaults.
- `app/db/supabase.py`: intended Supabase integration entry point; verify its implementation before relying on it.

At skill creation, persistence still used SQLite and local files; `supabase.py` was empty. Recheck this state instead of assuming the migration is complete. OCR predictions were in `report.json`, while database crop rows did not preserve plate text or track ID.

## Preserve pipeline and API meaning

- Keep heavy video processing in the worker and preserve the asynchronous job API unless the task changes that contract.
- Mark a job successful only after validated output and durable result persistence. Keep incomplete and failed states explicit.
- Frame indices are 1-based. Timestamps are video-relative sampler seconds, not capture wall-clock time or exact variable-frame-rate PTS. Bboxes use original-image pixels.
- Crop count is not unique vehicle count. Track IDs are scoped to their job/run, not global identities.
- Five-frame recognition currently requires exactly five selected crops. Treat short tracks as a defined state; do not silently duplicate images or change the model input contract.
- Detector confidence and fusion weights are not calibrated OCR confidence.
- Check decoder position classes and trained model compatibility for the target plate format. The default `LLLDDDD` does not cover every plate format; changing a regex/config alone does not retrain the model.
- Inspect checkpoint mapping before comparing model names. At creation, `yolo26n` resolved to the `yolo11n` checkpoint.

## Supabase integration direction

The user chose Supabase PostgreSQL for metadata and Supabase Storage for extracted frames/crops. Apply these decisions when implementing that integration:

- Keep database access in the repository layer and Storage operations in a separate service. A new connection URL alone does not migrate `sqlite3` SQL or transaction semantics.
- Use versioned schema migrations. Do not run migrations automatically from every API/worker startup against the shared development database.
- Prefer a private configurable bucket, initially `vehicle-frames`. Store bucket and object path in metadata, and generate short-lived signed URLs when serving authorized image requests.
- Keep privileged credentials server-side. Do not make a bucket public to fix authorization errors. Check job/image access before signing a URL.
- Use stable names such as `{job_id}/{crop_id}.jpg`; distinguish full video frames from plate crops. Existing Storage objects may retain their old team-prefixed paths.
- PostgreSQL and Storage do not share a transaction. Design retry-safe uploads and result import, bounded retries, and compensating cleanup for partial failures. Cleanup must target only objects owned by the relevant job/attempt, including when attempts overlap.
- Shared PostgreSQL does not make local video paths readable on other machines. Define shared input/output access before distributing workers.
- The original worker lock and restart recovery assume a single worker. Before enabling multiple workers, replace claiming/recovery with ownership-aware atomic claims and leases or an equivalent design. Never fail another live worker's jobs on startup.
- For plate search, preserve raw OCR alongside a normalized search value; normalize queries identically. Index exact searches, keep sightings separate, and show fuzzy matches explicitly instead of silently merging vehicle identities.
- The current Supabase schema is one shared workspace without teams. Every authenticated user can read shared results and use the job API; keep public sign-up closed until a replacement access policy exists. The initial migration creates this schema from empty app tables; `supabase/reset_vehicle_tracking.sql` removes only project metadata when an explicit reset is requested. Never drop Supabase auth/storage system tables.
- Store capture time only when source metadata supplies it; never substitute upload time.
- Do not invent current provider quotas or SDK signatures; check official documentation when those details matter.

## Verification

Use the project's Python environment (`.venv/bin/python` on macOS/Linux, `.venv\\Scripts\\python.exe` on Windows). Read `TESTING.md` and run tests relevant to the changed behavior; use `python -m pytest -q` for broader backend changes when dependencies are available.

Mock model inference and external Storage in unit tests. For persistence/storage work, cover duplicate processing, partial upload/database failure, cleanup boundaries, and search normalization as relevant. Test PostgreSQL-specific transaction behavior against an isolated PostgreSQL test database rather than assuming SQLite proves it.

Real model smoke tests in `scripts/smoke_local.py` require checkpoints and substantial compute. Run them when model/pipeline changes justify them and the environment is ready; otherwise report that inference was not exercised. Keep tests isolated from shared dev data.

Report changed files, checks actually run, and remaining setup. Skill installation or local code edits alone do not establish that Supabase is connected or deployed.

"""Compatibility entry point; the worker lives in app.workers.job_executor."""

from app.workers.job_executor import JobFailure, main, process_one

__all__ = ["JobFailure", "main", "process_one"]


if __name__ == "__main__":
    main()

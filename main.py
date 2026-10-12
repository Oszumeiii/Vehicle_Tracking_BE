"""Compatibility entry point; the application lives in app.main."""

from app.main import app, create_app

__all__ = ["app", "create_app"]

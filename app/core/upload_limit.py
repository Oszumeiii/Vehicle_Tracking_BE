import os

from starlette.formparsers import MultiPartException
from starlette.responses import JSONResponse


class UploadLimitMiddleware:
    """Bound multipart spooling as well as the final video copy, including chunked requests."""
    def __init__(self, app):
        self.app = app

    def _upload_policy(self, scope):
        path = scope["path"].rstrip("/")
        if path == "/api/v1/plate-jobs":
            maximum = scope["app"].state.jobs.settings.max_upload_bytes + 64 * 1024
            return maximum, JSONResponse({"detail": "Video exceeds the upload limit."}, status_code=413)
        if path == "/api/v1/model/predict":
            try:
                frame_limit = max(1, int(os.getenv("MODEL_MAX_FRAME_MIB", "8"))) * 1024 * 1024
            except ValueError:
                frame_limit = 8 * 1024 * 1024
            maximum = 5 * frame_limit + 64 * 1024
            return maximum, JSONResponse({"detail": "Model frames exceed the upload limit."}, status_code=413)
        return None

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST":
            return await self.app(scope, receive, send)
        policy = self._upload_policy(scope)
        if policy is None:
            return await self.app(scope, receive, send)
        maximum, error = policy

        headers = dict(scope["headers"])
        try:
            length = int(headers.get(b"content-length", b"0"))
        except ValueError:
            length = 0
        if length > maximum:
            return await error(scope, receive, send)
        received = 0
        exceeded = False
        replied = False

        async def limited_receive():
            nonlocal received, exceeded
            message = await receive()
            received += len(message.get("body", b""))
            if received > maximum:
                exceeded = True
                # The multipart parser closes its temporary files for this exception.
                raise MultiPartException("Upload limit exceeded")
            return message

        async def limited_send(message):
            nonlocal replied
            if exceeded:
                if not replied:
                    replied = True
                    await error(scope, receive, send)
            else:
                await send(message)

        await self.app(scope, limited_receive, limited_send)

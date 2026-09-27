from starlette.formparsers import MultiPartException
from starlette.responses import JSONResponse


class UploadLimitMiddleware:
    """Bound multipart spooling as well as the final video copy, including chunked requests."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST" or scope["path"].rstrip("/") != "/api/v1/plate-jobs":
            return await self.app(scope, receive, send)
        # Allow small multipart headers/form fields; the service enforces the exact file limit.
        maximum = scope["app"].state.jobs.settings.max_upload_bytes + 64 * 1024
        error = JSONResponse({"detail": "Video exceeds the upload limit."}, status_code=413)
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

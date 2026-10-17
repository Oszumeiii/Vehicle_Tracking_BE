"""Server-side Supabase client for database API and Storage access.

Configure NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
in the root .env file. This client uses public access and is subject to
database and Storage policies. Do not use this shared client for user
sign-in or mutate its auth session.
"""

from functools import lru_cache
import os
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

from dotenv import load_dotenv

from app.core.config import PROJECT_ROOT

if TYPE_CHECKING:
    from supabase import Client


@lru_cache(maxsize=1)
def get_supabase() -> "Client":
    """Lazily create a client per process; initialization does not verify access.

    Call from synchronous routes/workers, or offload SDK requests from async
    routes to a thread. Restart the process after changing credentials.
    """
    load_dotenv(PROJECT_ROOT / ".env", override=False)
    url = os.getenv("NEXT_PUBLIC_SUPABASE_URL", "").strip().rstrip("/")
    key = os.getenv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "").strip()
    if not url:
        raise RuntimeError("Set NEXT_PUBLIC_SUPABASE_URL in the root .env file.")
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https" or not parsed.hostname
        or parsed.username or parsed.password or parsed.query
        or parsed.fragment or parsed.path
    ):
        raise RuntimeError("NEXT_PUBLIC_SUPABASE_URL must be an HTTPS project URL.")
    if not key:
        raise RuntimeError(
            "Set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in the root .env file."
        )

    from supabase import create_client
    from supabase.client import ClientOptions

    return create_client(
        url,
        key,
        options=ClientOptions(
            auto_refresh_token=False,
            persist_session=False,
            postgrest_client_timeout=10,
            storage_client_timeout=30,
        ),
    )

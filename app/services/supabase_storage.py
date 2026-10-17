"""Private crop Storage. The server verifies team access before calling this service."""
from functools import lru_cache
import os
from dotenv import load_dotenv
from app.core.config import PROJECT_ROOT


@lru_cache(maxsize=1)
def get_storage_client():
    from supabase import create_client
    from supabase.client import ClientOptions
    load_dotenv(PROJECT_ROOT / '.env', override=False)
    url = os.getenv('NEXT_PUBLIC_SUPABASE_URL', '').strip()
    key = os.getenv('SUPABASE_SECRET_KEY', '').strip()
    if not url or not key:
        raise RuntimeError('Set NEXT_PUBLIC_SUPABASE_URL and server-only SUPABASE_SECRET_KEY for private Storage.')
    return create_client(url,key,options=ClientOptions(persist_session=False,auto_refresh_token=False,
                                                       postgrest_client_timeout=10,storage_client_timeout=30))


class CropStorage:
    bucket = 'vehicle-frames'

    def upload(self, object_path, path):
        with path.open('rb') as stream:
            get_storage_client().storage.from_(self.bucket).upload(object_path,stream,
                file_options={'content-type':'image/jpeg','upsert':'true'})

    def remove(self, paths):
        for i in range(0,len(paths),100):
            get_storage_client().storage.from_(self.bucket).remove(paths[i:i+100])

    def signed_url(self, object_path):
        return get_storage_client().storage.from_(self.bucket).create_signed_url(object_path,60)['signedURL']

"""Direct PostgreSQL access for server transactions and explicit migrations."""
import os
from dotenv import load_dotenv
import psycopg
from psycopg.rows import dict_row
from app.core.config import PROJECT_ROOT


def connect():
    load_dotenv(PROJECT_ROOT / '.env', override=False)
    dsn = os.getenv('SUPABASE_DB_URL', '').strip()
    if not dsn:
        raise RuntimeError('Set SUPABASE_DB_URL to the dev PostgreSQL connection string.')
    # Use a direct or session-pooler endpoint; worker locks require session affinity.
    return psycopg.connect(dsn, row_factory=dict_row, connect_timeout=10,
                           application_name='vehicle-tracking')

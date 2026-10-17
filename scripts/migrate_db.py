"""Apply checked-in migrations atomically. Never invoked by API startup."""
import hashlib
from pathlib import Path
from app.core.config import PROJECT_ROOT
from app.db.postgres import connect


def migrate(connection_factory=connect, directory=None):
    directory = Path(directory or PROJECT_ROOT / 'supabase' / 'migrations')
    applied = []
    with connection_factory() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(713601701)")
        conn.execute('CREATE SCHEMA IF NOT EXISTS vehicle_private')
        conn.execute('REVOKE ALL ON SCHEMA vehicle_private FROM PUBLIC')
        conn.execute('''CREATE TABLE IF NOT EXISTS vehicle_private.schema_migrations
                     (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())''')
        for path in sorted(directory.glob('*.sql')):
            source = path.read_text(encoding='utf-8')
            digest = hashlib.sha256(source.encode()).hexdigest()
            row = conn.execute('SELECT sha256 FROM vehicle_private.schema_migrations WHERE name=%s', (path.name,)).fetchone()
            if row:
                if row['sha256'] != digest:
                    raise RuntimeError('Applied migration changed: ' + path.name)
                continue
            conn.execute(source)
            conn.execute('INSERT INTO vehicle_private.schema_migrations(name,sha256) VALUES(%s,%s)', (path.name,digest))
            applied.append(path.name)
    return applied


if __name__ == '__main__':
    try:
        names = migrate()
    except Exception as exc:
        # Database errors can contain credentials/connection details. Do not echo them.
        raise SystemExit(f'Migration failed ({type(exc).__name__}); check dev connection and schema.') from None
    print('Applied: ' + ', '.join(names) if names else 'Database is up to date.')

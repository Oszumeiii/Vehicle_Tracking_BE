// Load test: how the investigation endpoints behave with millions of live reads.
//
// usage (after `npm run build`; PG_BIN = the folder of pg_ctl, as for the tests):
//   $env:PG_BIN='C:\Program Files\PostgreSQL\18\bin'
//   node scripts/load-test.mjs [--reads 2000000] [--cameras 20] [--days 180] [--plates 300000]
//                              [--watchlist 10000] [--runs 7] [--out data/load-test.json]
//                              [--base ../other-checkout] [--keep]
//
// Starts a throwaway PostgreSQL cluster under data/ (like the tests), applies the
// migrations and writes synthetic cameras, sessions and live reads: plates repeat like
// commuter traffic (a few plates very often, most rarely), 5 crops per read, a watchlist.
// Then it times the API as an administrator and the ingest of new tracks (median and
// slowest of --runs requests). Nothing touches the real database.
//
// --base compares two builds on the same data: the cluster gets that checkout's
// migrations and is measured with its code first; then this checkout's newer migrations
// are applied and its code is measured. Both checkouts must be built.
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const READS = Number(option('reads', 2_000_000));
const CAMERAS = Number(option('cameras', 20));
const DAYS = Number(option('days', 180));
const PLATES = Number(option('plates', 300_000));
const WATCHLIST = Number(option('watchlist', 10_000));
const RUNS = Number(option('runs', 7));
const OUT = resolve(option('out', 'data/load-test.json'));
const KEEP = args.includes('--keep');
// Longest a measured request may take; slower scenarios are reported as "> LIMIT_SECONDS".
const LIMIT_SECONDS = Number(option('limit-seconds', 120));
// --only REGEX: measure only the scenarios whose name matches (e.g. after one fix).
const ONLY = option('only') ? new RegExp(option('only'), 'i') : null;
const HERE = process.cwd();
const CHECKOUTS = option('base') ? [resolve(option('base')), HERE] : [HERE];

const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);
const seconds = (start) => `${((performance.now() - start) / 1000).toFixed(1)} s`;
const load = (checkout, file) => import(pathToFileURL(join(checkout, 'dist', file)).href);

// Migrations are read from the working directory: start in the first (older) checkout.
process.chdir(CHECKOUTS[0]);
const { seedUser, startTestDatabase } = await load(CHECKOUTS[0], 'tests/helpers.js');
const { livePipelines, writeTrack } = await load(CHECKOUTS[0], 'tests/live-fixtures.js');
const { Database } = await load(CHECKOUTS[0], 'src/database/database.js');
const PG_CTL = join(process.env.PG_BIN ?? '', process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl');

/**
 * --attach ROOT: measure the cluster an earlier run kept (--keep) or left behind when it
 * was stopped after building its data, instead of building a new one (about 25 minutes).
 */
async function attach(root) {
  if (!/[\\/]data[\\/]test-postgres-[a-f0-9]{32}$/.test(root))
    throw new Error('--attach takes the data/test-postgres-<id> folder of an earlier run');
  const port = await new Promise((done) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port: free } = server.address();
      server.close(() => done(free));
    });
  });
  const cluster = join(root, 'cluster');
  // No pipes: the server inherits them and pg_ctl would never seem to finish.
  execFileSync(PG_CTL, ['-D', cluster, '-l', join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', '-t', '600', 'start'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const url = `postgresql://plate_test@127.0.0.1:${port}/postgres`;
  const database = new Database(url);
  return {
    database,
    url,
    root,
    async dispose() {
      await database.onModuleDestroy().catch(() => undefined);
      execFileSync(PG_CTL, ['-D', cluster, '-m', 'fast', '-w', '-t', '120', 'stop'], { stdio: 'ignore', windowsHide: true });
      await rm(root, { recursive: true, force: true });
    },
  };
}

const ATTACH = option('attach') ? resolve(option('attach')) : null;
const fixture = ATTACH ? await attach(ATTACH) : await startTestDatabase();
const db = fixture.database;

// The model's alternative readings (migration 0023), about 1.1 per read as on ICPR: the
// plate with its last digit changed, for 70% of the reads, and a second one for 40%.
const CANDIDATES_SQL = `INSERT INTO plate_candidates (appearance_id, rank, text, probability)
  SELECT appearance, k, overlay(plate PLACING ((substr(plate, 7, 1)::int + 3 * k) % 10)::text FROM 7 FOR 1),
    (0.05 + 0.4 * random()) / k
  FROM load_reads CROSS JOIN generate_series(1, 2) k
  WHERE g BETWEEN $1 AND $2 AND g % 10 < CASE k WHEN 1 THEN 7 ELSE 4 END`;
const hasCandidates = async () => (await db.query("SELECT to_regclass('plate_candidates') AS t")).rows[0].t !== null;
const dataDir = join(fixture.root, 'artifacts');
let app;

async function serve(checkout, admin) {
  const { createApp } = await load(checkout, 'src/main.js');
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  const login = await (
    await fetch(`${base}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: admin.email, password: admin.password }),
    })
  ).json();
  return async (path, init = {}) => {
    const response = await fetch(base + path, {
      ...init,
      headers: { authorization: `Bearer ${login.access_token}`, 'content-type': 'application/json', ...init.headers },
      signal: AbortSignal.timeout((LIMIT_SECONDS + 60) * 1000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(body)}`);
    return body;
  };
}

try {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: fixture.url,
    PLATE_DATA_DIR: dataDir,
    PLATE_PIPELINE_PYTHON: process.execPath, // file checks only; nothing is inferred
    PLATE_PIPELINES_CONFIG: ATTACH ? join(fixture.root, 'models', 'pipelines.json') : await livePipelines(fixture.root),
  });
  const admin = await seedUser(db, 'admin');
  let call;
  let start = performance.now();
  let cameras = [];
  let live;
  if (ATTACH) {
    cameras = (await db.query('SELECT id FROM stream_sources ORDER BY name')).rows;
    live = (await db.query("SELECT id FROM live_sessions WHERE status <> 'ended' ORDER BY created_at LIMIT 1")).rows[0];
    log(`attached to ${fixture.root}: ${cameras.length} cameras`);
  } else {
  call = await serve(CHECKOUTS[0], admin);
  // Cameras through the API, with one real session (its snapshot is copied to the others).
  for (let i = 0; i < CAMERAS; i++)
    cameras.push(
      await call('/api/v2/stream-sources', {
        method: 'POST',
        body: JSON.stringify({
          name: `Camera ${String(i + 1).padStart(2, '0')}`,
          url: 'https://www.youtube.com/watch?v=5Xl6pSgiy3A',
          location: { latitude: -26.99 + i * 0.002, longitude: -48.63 + i * 0.001 },
        }),
      }),
    );
  live = await call(`/api/v2/stream-sources/${cameras[0].id}/sessions`, {
    method: 'POST',
    body: JSON.stringify({ pipeline_id: 'joint' }),
  });
  await db.query('UPDATE stream_sources SET track_retention_days=NULL, keyframe_retention_hours=NULL');
  log(`cameras: ${CAMERAS} (${seconds(start)})`);

  start = performance.now();
  await db.query(`
    CREATE OR REPLACE FUNCTION load_plate(n bigint) RETURNS text LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE WHEN h % 10 < 7
        THEN chr((65 + h % 26)::int) || chr((65 + h / 26 % 26)::int) || chr((65 + h / 676 % 26)::int)
          || (h / 17576 % 10)::text || chr((65 + h / 175760 % 26)::int) || lpad((h / 4569760 % 100)::text, 2, '0')
        ELSE chr((65 + h % 26)::int) || chr((65 + h / 26 % 26)::int) || chr((65 + h / 676 % 26)::int)
          || lpad((h / 17576 % 10000)::text, 4, '0')
      END FROM (SELECT (n * 2654435761) % 2147483647 AS h) x
    $$`);
  // One session per camera and day, all ended, sharing the real session's snapshot.
  await db.query(
    `INSERT INTO live_sessions (id, stream_source_id, requested_by, pipeline_snapshot, settings, status,
       created_at, started_at, finished_at, tracks_count)
     SELECT md5('s' || c.n || '-' || d), c.id, $1, l.pipeline_snapshot, l.settings, 'ended',
       t, t, t + interval '23 hours', 0
     FROM (SELECT id, row_number() OVER (ORDER BY name) AS n FROM stream_sources) c
     CROSS JOIN generate_series(0, $2 - 1) d
     CROSS JOIN (SELECT pipeline_snapshot, settings FROM live_sessions WHERE id=$3) l
     CROSS JOIN LATERAL (SELECT date_trunc('day', now()) - make_interval(days => $2 - d) AS t) x`,
    [admin.id, DAYS, live.id],
  );
  // The reads: camera, day and time spread out; plate index skewed towards small numbers.
  await db.query(
    `CREATE UNLOGGED TABLE load_reads AS
     SELECT g, md5('j' || g) AS job, md5('a' || g) AS appearance,
       md5('s' || (1 + g % $2) || '-' || ((g * 7919) % $3)) AS session,
       date_trunc('day', now()) - make_interval(days => ($3 - (g * 7919) % $3)::int)
         + make_interval(secs => (g * 104729) % 86400) AS t,
       load_plate(1 + floor($4 * power(random(), 2))::bigint) AS plate,
       0.5 + 0.5 * random() AS confidence
     FROM generate_series(1::bigint, $1::bigint) g`,
    [READS, CAMERAS, DAYS, PLATES],
  );
  await db.query('CREATE INDEX ON load_reads (g)');
  log(`generated ${READS} reads (${seconds(start)})`);
  // Batches of 250 000 reads, without the per-row foreign-key triggers: in one statement
  // their queued events held so much memory that a first 2-million-read run was stopped
  // on a 15 GB laptop. The synthetic rows are consistent by construction.
  const BATCH = 250_000;
  const insert = async (label, sql) => {
    const t0 = performance.now();
    // Plain indexes (not backing a constraint) are dropped and built again afterwards:
    // building once is much faster than updating them row by row.
    const indexes = (
      await db.query(
        `SELECT i.indexrelid::regclass::text AS name, pg_get_indexdef(i.indexrelid) AS def
         FROM pg_index i WHERE i.indrelid = $1::regclass AND NOT i.indisprimary
           AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid)`,
        [label],
      )
    ).rows;
    for (const { name } of indexes) await db.query(`DROP INDEX ${name}`);
    for (let from = 1; from <= READS; from += BATCH)
      await db.transaction(async (c) => {
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(sql, [from, Math.min(READS, from + BATCH - 1)]);
      });
    for (const { def } of indexes)
      await db.transaction(async (c) => {
        await c.query("SET LOCAL maintenance_work_mem = '256MB'");
        await c.query(def);
      });
    log(`${label} (${seconds(t0)}, ${indexes.length} indexes rebuilt)`);
  };
  await insert(
    'recognition_jobs',
    `INSERT INTO recognition_jobs (id, live_session_id, live_track_key, job_kind, input_mode, pipeline_snapshot,
       status, stage, statistics, created_at, started_at, finished_at, captured_from, captured_to,
       confidence_status, sighting_id, evidence_bytes)
     SELECT job, session, 'e' || lpad((g / 1000000)::text, 3, '0') || '-t' || lpad((g % 1000000)::text, 6, '0'),
       'recognize', 'scene', '{"id": "joint", "version": "1"}', 'succeeded', 'complete',
       jsonb_build_object('epoch', 0, 'observations', 12, 'confidence', confidence, 'capture_clock', 'stream', 'sampling_scale', 1),
       t, t, t, t, t + interval '2 seconds',
       CASE WHEN confidence >= 0.85 THEN 'readable' ELSE 'low_confidence' END, job, 600000
     FROM load_reads WHERE g BETWEEN $1 AND $2`,
  );
  await insert(
    'plate_appearances',
    `INSERT INTO plate_appearances (id, job_id, source_track_id, first_frame, last_frame, start_seconds, end_seconds,
       machine_text, machine_status, agreement_count, effective_text, review_status, recognition_method)
     SELECT appearance, job, 'e000-t' || g, 8, 40, 100.8, 104, plate, 'readable', NULL, plate,
       CASE WHEN g % 50 = 0 THEN 'confirmed' ELSE 'pending' END, 'joint_multiframe'
     FROM load_reads WHERE g BETWEEN $1 AND $2`,
  );
  if (await hasCandidates()) await insert('plate_candidates', CANDIDATES_SQL);
  await insert(
    'plate_detections',
    `INSERT INTO plate_detections (id, appearance_id, selected_order, frame_index, timestamp_seconds, timestamp_source,
       bbox, crop_bbox, detection_score, crop_storage_key, frame_storage_key, crop_width, crop_height)
     SELECT md5('d' || g || '-' || k), appearance, k, k * 8, 100 + k * 0.8, 'live_pts',
       '[100, 200, 180, 226]', '[88, 196, 192, 230]', 0.9,
       'recognition/' || job || '/crops/0' || k || '.png',
       CASE WHEN k = 3 THEN 'recognition/' || job || '/keyframes/frame_' || k || '.jpg' END,
       60 + g % 60, 22
     FROM load_reads CROSS JOIN generate_series(1, 5) k WHERE g BETWEEN $1 AND $2`,
  );
  start = performance.now();
  await db.query(
    `UPDATE live_sessions s SET tracks_count=n FROM (SELECT session, count(*) AS n FROM load_reads GROUP BY 1) r
     WHERE r.session=s.id`,
  );
  await db.query(
    `INSERT INTO plate_watchlist (id, owner_id, plate, reason, priority, shared)
     SELECT md5('w' || i), $1, p, 'stolen', 'normal', i % 2 = 0
     FROM (SELECT DISTINCT load_plate((i * 7)::bigint) AS p, i FROM generate_series(1, $2) i) w
     ON CONFLICT DO NOTHING`,
    [admin.id, WATCHLIST],
  );
  await db.query('VACUUM ANALYZE');
  // A query still running after 2 minutes is cancelled by the server: a client that gave
  // up would otherwise leave it running and slow every later measurement.
  const name = (await db.query('SELECT current_database() AS name')).rows[0].name;
  await db.query(`ALTER DATABASE "${name}" SET statement_timeout = '${LIMIT_SECONDS}s'`);
  log(`watchlist and analyze (${seconds(start)})`);
  }

  const sizes = (
    await db.query(
      `SELECT relname AS table, n_live_tup AS rows, pg_size_pretty(pg_total_relation_size(relid)) AS size
       FROM pg_stat_user_tables WHERE relname IN ('recognition_jobs','plate_appearances','plate_detections','plate_candidates','live_sessions','plate_watchlist')
       ORDER BY pg_total_relation_size(relid) DESC`,
    )
  ).rows;
  const database = (await db.query('SELECT pg_size_pretty(pg_database_size(current_database())) AS size')).rows[0].size;
  console.table(sizes);
  log(`database ${database}`);

  // Plates to look for: the most frequent, a rare one, a one-off misread and a fragment
  // (from the stored reads: load_reads is unlogged, so a crash or kill empties it).
  const frequent = (
    await db.query(
      'SELECT effective_text AS plate, count(*)::int AS n FROM plate_appearances GROUP BY 1 ORDER BY n DESC LIMIT 1',
    )
  ).rows[0];
  const rare = (
    await db.query('SELECT effective_text AS plate FROM plate_appearances GROUP BY 1 HAVING count(*) = 1 LIMIT 1')
  ).rows[0].plate;
  const misread = frequent.plate.slice(0, 3) + (frequent.plate[3] === '9' ? '8' : '9') + frequent.plate.slice(4);
  const fragment = frequent.plate.slice(2, 5);
  const day = (await db.query('SELECT max(captured_from) AS t FROM recognition_jobs')).rows[0].t;
  const dayFrom = new Date(new Date(day).getTime() - 86_400_000).toISOString();
  const dayTo = new Date(day).toISOString();
  log(`frequent plate ${frequent.plate} (${frequent.n} reads), rare ${rare}, misread ${misread}, fragment ${fragment}`);
  const scenarios = [
    ['Kết quả, trang đầu (không lọc)', '/api/v2/recognition-results?limit=50'],
    ['Kết quả gộp theo lượt xe', '/api/v2/recognition-results?limit=50&group_by=sighting'],
    ['Camera + một ngày', `/api/v2/recognition-results?limit=50&stream_source_id=${cameras[1].id}&captured_from=${dayFrom}&captured_to=${dayTo}`],
    ['Tìm biển chính xác (biển gặp nhiều)', `/api/v2/recognition-results?limit=50&match=exact&plate=${frequent.plate}`],
    ['Tìm xấp xỉ (ký tự dễ nhầm, ≤ 2 ký tự)', `/api/v2/recognition-results?limit=50&match=similar&plate=${frequent.plate}`],
    ['Biển gần giống (tóm tắt xấp xỉ)', `/api/v2/plates/${frequent.plate}/similar`],
    ['Tìm biển chính xác (biển hiếm)', `/api/v2/recognition-results?limit=50&match=exact&plate=${rare}`],
    ['Tìm "có chứa" 3 ký tự', `/api/v2/recognition-results?limit=50&match=contains&plate=${fragment}`],
    ['Tìm gần đúng (đọc sai 1 ký tự)', `/api/v2/recognition-results?limit=50&match=fuzzy&plate=${misread}`],
    ['Hành trình (chính xác)', `/api/v2/plates/${frequent.plate}/journey`],
    ['Hành trình (gần đúng)', `/api/v2/plates/${frequent.plate}/journey?match=fuzzy`],
    ['Dung lượng lưu trữ (admin)', '/api/v2/system/storage'],
    ['Sức khỏe hệ thống (admin)', '/api/v2/system/health'],
  ].filter(([name]) => !ONLY || ONLY.test(name));
  const INGEST = `Nhập một track mới (watchlist ${WATCHLIST} biển)`;

  const runs = [];
  for (const [index, checkout] of CHECKOUTS.entries()) {
    // A fresh app per measured build: its connections start with the statement timeout.
    await app?.close();
    app = undefined;
    if (index > 0) {
      // The newer checkout: its migrations on the same data, then its code.
      process.chdir(checkout);
      const { migrate } = await load(checkout, 'src/database/migrate.js');
      start = performance.now();
      // Its own connection without the statement timeout: building an index over all
      // reads may take longer than a measured request is allowed to.
      const migrator = new Database(`${fixture.url}?options=-c%20statement_timeout%3D0`);
      const applied = await migrate(migrator);
      // Alternatives the older schema had no table for, so both builds search the same reads.
      if (applied.includes('0023_plate_candidates.sql'))
        for (let from = 1; from <= READS; from += 250_000)
          await migrator.transaction(async (c) => {
            await c.query('SET LOCAL session_replication_role = replica');
            await c.query(CANDIDATES_SQL, [from, Math.min(READS, from + 250_000 - 1)]);
          });
      await migrator.query('ANALYZE');
      await migrator.onModuleDestroy();
      log(`${checkout}: applied ${applied.join(', ') || 'no migration'} (${seconds(start)})`);
    }
    call = await serve(checkout, admin);
    const { ingestTrack } = await load(checkout, 'src/live/ingest.js');
    const { workerOptions } = await load(checkout, 'src/recognition/engine.js');
    const results = [];
    for (const [name, path] of scenarios) {
      const times = [];
      let total = null;
      let failed = null;
      // Run 0 warms up; a request that fails (or hits the time limit) ends the scenario.
      for (let i = 0; i <= RUNS && !failed; i++) {
        const t0 = performance.now();
        try {
          const body = await call(path);
          if (i > 0) times.push(performance.now() - t0);
          total = body?.total ?? body?.points?.length ?? null;
        } catch (error) {
          failed = `${Math.round((performance.now() - t0) / 1000)} s: ${String(error?.message ?? error).slice(0, 120)}`;
        }
      }
      times.sort((a, b) => a - b);
      const row = failed
        ? { scenario: name, median_ms: null, max_ms: null, total, failed }
        : { scenario: name, median_ms: Math.round(times[times.length >> 1]), max_ms: Math.round(times.at(-1)), total };
      results.push(row);
      log(failed ? `${name}: FAILED after ${failed}` : `${name}: ${row.median_ms} ms (max ${row.max_ms}), total ${total}`);
    }
    if (ONLY && !ONLY.test(INGEST)) {
      console.table(results);
      runs.push({ checkout, results });
      continue;
    }
    // Ingest of new tracks on the first camera: sighting lookup, watchlist match, inserts.
    const session = (await db.query('SELECT * FROM live_sessions WHERE id=$1', [live.id])).rows[0];
    const ingest = [];
    // A new epoch of that session per measurement (also when attaching to it again).
    const epoch =
      1 +
      Number(
        (
          await db.query(
            'SELECT coalesce(max(substr(live_track_key, 2, 3)::int), 899) AS e FROM recognition_jobs WHERE live_session_id=$1',
            [live.id],
          )
        ).rows[0].e,
      );
    for (let i = 1; i <= 20; i++) {
      const key = `e${String(epoch).padStart(3, '0')}-t${String(i).padStart(6, '0')}`;
      await writeTrack(dataDir, session.id, key, { text: i % 4 === 0 ? frequent.plate : `ZZ${i}X${String(i).padStart(3, '0')}` });
      const t0 = performance.now();
      await ingestTrack(db, workerOptions(), session, key);
      ingest.push(performance.now() - t0);
    }
    ingest.sort((a, b) => a - b);
    results.push({
      scenario: INGEST,
      median_ms: Math.round(ingest[ingest.length >> 1]),
      max_ms: Math.round(ingest.at(-1)),
      total: null,
    });
    log(`ingest: ${results.at(-1).median_ms} ms (max ${results.at(-1).max_ms})`);
    console.table(results);
    runs.push({ checkout, results });
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(
    OUT,
    JSON.stringify(
      { at: new Date().toISOString(), reads: READS, cameras: CAMERAS, days: DAYS, plates: PLATES, watchlist: WATCHLIST, runs: RUNS, database, sizes, frequent, rare, misread, fragment, measured: runs },
      null,
      2,
    ),
  );
  log(`written ${OUT}`);
} finally {
  if (app) await app.close();
  if (KEEP) log(`kept the database at ${fixture.url} (${fixture.root}); stop it with pg_ctl -D <root>/cluster stop`);
  else await fixture.dispose();
}

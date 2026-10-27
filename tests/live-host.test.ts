import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { SharedLiveHost } from '../src/live/host';
import { Fake, fakeChild } from './live-fixtures';

let dataDir: string;
before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'live-host-'));
});
after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const args = (session: string) => [
  '-m',
  'app.live',
  '--payload',
  join(dataDir, 'live', session, 'payload.json'),
  '--out',
  join(dataDir, 'live', session),
  '--data-dir',
  dataDir,
  '--min-confidence',
  '0.9',
  '--max-track-seconds',
  '20',
];

/** Host processes the shared host spawned, with the commands written to each one's stdin. */
function fakeHosts() {
  const hosts: { args: string[]; child: Fake; commands: any[] }[] = [];
  const spawn = (_python: string, spawnArgs: string[]) => {
    const child = fakeChild();
    const entry = { args: spawnArgs, child, commands: [] as any[] };
    createInterface({ input: child.stdin as unknown as NodeJS.ReadableStream }).on('line', (line) =>
      entry.commands.push(JSON.parse(line)),
    );
    hosts.push(entry);
    return child;
  };
  return { hosts, spawn };
}

function lines(child: { stdout: NodeJS.ReadableStream | null }) {
  const events: any[] = [];
  createInterface({ input: child.stdout! }).on('line', (line) => events.push(JSON.parse(line)));
  return events;
}

const closed = (child: NodeJS.EventEmitter) =>
  new Promise<number | null>((resolve) => child.once('close', resolve));

test('sessions share one host process, get their own events and stop independently', async () => {
  const { hosts, spawn } = fakeHosts();
  const shared = new SharedLiveHost(spawn, dataDir, 0.5);
  const a = shared.spawn('python', args('a'));
  const b = shared.spawn('python', args('b'));
  await tick();
  assert.equal(hosts.length, 1, 'one process for both sessions');
  assert.deepEqual(hosts[0].args, [
    '-m',
    'app.live',
    '--host',
    '--data-dir',
    dataDir,
    '--sampling-scale',
    '0.5',
  ]);
  assert.deepEqual(
    hosts[0].commands.map((c) => [c.cmd, c.session, c.min_confidence, c.max_track_seconds]),
    [
      ['start', 'a', 0.9, 20],
      ['start', 'b', 0.9, 20],
    ],
  );
  assert.equal(hosts[0].commands[0].payload, join(dataDir, 'live', 'a', 'payload.json'));
  const [eventsA, eventsB] = [lines(a), lines(b)];
  const host = hosts[0].child;
  host.line({ type: 'host', status: 'ready' });
  host.line({ type: 'status', status: 'running', session: 'a' });
  host.line({ type: 'track', track: 'e000-t000001', session: 'b' });
  await tick();
  assert.deepEqual(eventsA, [{ type: 'status', status: 'running' }]);
  assert.deepEqual(eventsB, [{ type: 'track', track: 'e000-t000001' }]);

  a.stdin!.write('stop\n');
  await tick();
  assert.deepEqual(hosts[0].commands.at(-1), { cmd: 'stop', session: 'a' });
  const aClosed = closed(a);
  host.line({ type: 'exit', code: 0, session: 'a' });
  assert.equal(await aClosed, 0);
  assert.equal(shared.size, 1);
  assert.equal((host.stdin as any).writableEnded, false, 'the host stays for b');

  const bClosed = closed(b);
  host.line({ type: 'exit', code: 1, session: 'b' });
  assert.equal(await bClosed, 1);
  await tick();
  assert.equal((host.stdin as any).writableEnded, true, 'the last session out stops the host');

  // A session started while the old host is still exiting waits for a new host.
  const c = shared.spawn('python', args('c'));
  await tick();
  assert.equal(hosts.length, 1);
  host.exit(0);
  await tick();
  assert.equal(hosts.length, 2);
  assert.deepEqual(
    hosts[1].commands.map((cmd) => [cmd.cmd, cmd.session]),
    [['start', 'c']],
  );

  // A crashed host ends its sessions like exited processes.
  const cClosed = closed(c);
  hosts[1].child.exit(1);
  assert.equal(await cClosed, null);
  assert.equal(shared.size, 0);
});

/** Whether the shared host closed this host process's stdin (asked it to exit). */
const ended = (child: Fake) => (child.stdin as unknown as { writableEnded: boolean }).writableEnded;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const snapshot = (id: string) => ({ id, version: '1', device: 'cuda', detector: { sha256: 'a' } });

test('upload jobs run in the session host and a warm host is reused, restarted or released', async () => {
  const { hosts, spawn } = fakeHosts();
  const shared = new SharedLiveHost(spawn, dataDir, 1, 0.05);
  const session = shared.spawn('python', args('s1'));
  await tick();
  const job = shared.runJob('python', 'job1', join(dataDir, 'in.json'), snapshot('joint'));
  await tick();
  assert.equal(hosts.length, 1, 'the job joined the session host');
  assert.deepEqual(hosts[0].commands.at(-1), {
    cmd: 'job',
    job: 'job1',
    payload: join(dataDir, 'in.json'),
  });
  assert.equal(shared.members, 2);
  job.stop();
  await tick();
  assert.deepEqual(hosts[0].commands.at(-1), { cmd: 'stop_job', job: 'job1' });
  hosts[0].child.line({ type: 'exit', job: 'job1', code: 1 });
  assert.equal(await job.exit, 1);
  hosts[0].child.line({ type: 'exit', session: 's1', code: 0 });
  assert.equal(await closed(session), 0);
  // Warm: the host outlives its last member for idleSeconds and is reused meanwhile.
  const second = shared.runJob('python', 'job2', join(dataDir, 'in.json'), snapshot('joint'));
  await tick();
  assert.equal(hosts.length, 1);
  hosts[0].child.line({ type: 'exit', job: 'job2', code: 0 });
  assert.equal(await second.exit, 0);
  // Another pipeline while idle: the warm host is ended and a fresh one started.
  assert.ok(shared.accepts(snapshot('other')), 'an idle host may be restarted');
  const third = shared.runJob('python', 'job3', join(dataDir, 'in.json'), snapshot('other'));
  assert.ok(ended(hosts[0].child));
  hosts[0].child.exit(0);
  await tick();
  assert.equal(hosts.length, 2);
  assert.equal(shared.accepts(snapshot('joint')), false, 'busy with other models');
  hosts[1].child.line({ type: 'exit', job: 'job3', code: 0 });
  assert.equal(await third.exit, 0);
  // Idle timeout ends the host; stopIdle waits for it to exit.
  assert.ok(!ended(hosts[1].child));
  await wait(120);
  assert.ok(ended(hosts[1].child), 'ended after idleSeconds');
  hosts[1].child.exit(0);
  await shared.stopIdle();
});

test('a job ends with null when the host dies, and stopIdle ends a warm host at once', async () => {
  const { hosts, spawn } = fakeHosts();
  const shared = new SharedLiveHost(spawn, dataDir, 1, 3600);
  const job = shared.runJob('python', 'job1', join(dataDir, 'in.json'), snapshot('joint'));
  await tick();
  hosts[0].child.exit(1);
  assert.equal(await job.exit, null);
  const next = shared.runJob('python', 'job2', join(dataDir, 'in.json'), snapshot('joint'));
  await tick();
  hosts[1].child.line({ type: 'exit', job: 'job2', code: 0 });
  assert.equal(await next.exit, 0);
  const stopping = shared.stopIdle();
  assert.ok(ended(hosts[1].child), 'a warm idle host is ended at once');
  hosts[1].child.exit(0);
  await stopping;
});

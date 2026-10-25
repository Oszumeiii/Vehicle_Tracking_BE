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

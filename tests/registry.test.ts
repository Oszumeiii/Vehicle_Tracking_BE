import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PipelineRegistry } from '../src/recognition/registry';
import { livePipelines } from './live-fixtures';

async function withConfig(edit: (document: any) => void, run: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'registry-'));
  const saved = { ...process.env };
  try {
    const config = await livePipelines(root);
    const document = JSON.parse(await readFile(config, 'utf8'));
    edit(document);
    await writeFile(config, JSON.stringify(document));
    process.env.PLATE_PIPELINES_CONFIG = config;
    process.env.PLATE_PIPELINE_PYTHON = process.execPath; // Any existing file will do.
    await run();
  } finally {
    process.env = saved;
    await rm(root, { recursive: true, force: true });
  }
}

test('a renamed pipeline still resolves by its former id and records the current id', async () => {
  await withConfig(
    (document) => {
      document.pipelines[0].aliases = ['old-joint'];
    },
    async () => {
      const registry = new PipelineRegistry();
      const snapshot = await registry.resolve('old-joint');
      assert.equal(snapshot.id, 'joint');
      assert.equal('aliases' in snapshot, false);
      assert.equal((await registry.resolve('joint')).id, 'joint');
      assert.deepEqual(
        (await registry.list()).map((item) => item.id),
        ['joint', 'single'],
      );
      await assert.rejects(registry.resolve('unknown'), /Unknown pipeline/);
    },
  );
});

test('pipeline aliases must be unique ids', async () => {
  await withConfig(
    (document) => {
      document.pipelines[0].aliases = ['single'];
    },
    async () => {
      await assert.rejects(new PipelineRegistry().resolve('joint'), /configuration/);
    },
  );
  await withConfig(
    (document) => {
      document.pipelines[0].aliases = 'old-joint';
    },
    async () => {
      await assert.rejects(new PipelineRegistry().resolve('joint'), /configuration/);
    },
  );
});

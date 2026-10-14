import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/main';

test('OpenAPI exposes usable client contracts without a database connection', async (t) => {
  const previous = {
    DATABASE_URL: process.env.DATABASE_URL,
    PLATE_DATA_DIR: process.env.PLATE_DATA_DIR,
    NODE_ENV: process.env.NODE_ENV,
  };
  const root = await mkdtemp(join(tmpdir(), 'plate-openapi-'));
  process.env.DATABASE_URL = 'postgresql://openapi:unused@127.0.0.1:1/openapi_unused';
  process.env.PLATE_DATA_DIR = root;
  process.env.NODE_ENV = 'test';
  const app = await createApp();
  try {
    const { body: spec } = await request(app.getHttpServer()).get('/docs-json').expect(200);
    const schemas = spec.components.schemas;
    const success = (path: string, method: string, status: number) =>
      spec.paths[path][method].responses[String(status)];
    const json = (path: string, method = 'get', status = 200) =>
      success(path, method, status).content['application/json'].schema;

    await t.test('every business success has a schema, with bearer authentication', () => {
      for (const [path, methods] of Object.entries(spec.paths) as [string, any][]) {
        if (!path.startsWith('/api/')) continue;
        for (const [method, operation] of Object.entries(methods) as [string, any][]) {
          assert.ok(operation.responses, `${method} ${path} has responses`);
          const responses = Object.entries(operation.responses).filter(([code]) => /^2/.test(code));
          assert.ok(responses.length, `${method} ${path} has a success response`);
          for (const [code, response] of responses as [string, any][]) {
            if (code === '204') assert.equal(response.content, undefined);
            else
              assert.ok(
                Object.values(response.content ?? {}).some((v: any) => v.schema),
                `${method} ${path} ${code} has a schema`,
              );
          }
          if (path !== '/api/v2/auth/login')
            assert.ok(
              operation.security.some((entry: any) => 'bearer' in entry),
              `${method} ${path} requires bearer`,
            );
        }
      }
      assert.equal(json('/api/v2/auth/login', 'post').$ref, '#/components/schemas/LoginResponse');
      assert.equal(
        json('/api/v2/recognition-jobs', 'post', 202).$ref,
        '#/components/schemas/AcceptedJobResponse',
      );
      assert.equal(json('/api/v2/media', 'post', 201).$ref, '#/components/schemas/MediaResponse');
    });

    await t.test('page envelopes and nested result schemas preserve actual response shapes', () => {
      for (const path of [
        '/api/v2/users',
        '/api/v2/media',
        '/api/v2/recognition-jobs',
        '/api/v2/recognition-jobs/{id}/results',
        '/api/v2/recognition-results',
      ]) {
        const page = json(path);
        for (const field of ['total', 'limit', 'offset', 'items'])
          assert.ok(page.required.includes(field));
        assert.equal(page.properties.items.type, 'array');
        assert.ok(page.properties.items.items.$ref);
      }
      assert.equal(
        schemas.ResultDetailResponse.properties.detections.items.$ref,
        '#/components/schemas/DetectionResponse',
      );
      assert.equal(
        schemas.ResultDetailResponse.properties.reviews.items.$ref,
        '#/components/schemas/ReviewResponse',
      );
      assert.equal(
        schemas.ResultDetailResponse.properties.predictions.items.$ref,
        '#/components/schemas/JointPredictionResponse',
      );
      assert.equal(schemas.AppearanceResponse.properties.agreement_count.nullable, true);
      assert.deepEqual(schemas.AppearanceResponse.properties.recognition_method.enum, [
        'single_image',
        'per_crop_majority',
        'joint_multiframe',
      ]);
      assert.equal(schemas.JointPredictionResponse.properties.detection_ids.minItems, 5);
      assert.equal(schemas.JointPredictionResponse.properties.frame_weights.nullable, true);
      assert.equal(
        schemas.DetectionResponse.properties.predictions.items.$ref,
        '#/components/schemas/PredictionResponse',
      );
      assert.ok(schemas.MediaResponse.required.includes('media_id'));
      assert.equal(schemas.SearchResultResponse.properties.media_id.type, 'string');
      assert.equal(schemas.AppearanceResponse.properties.media_id, undefined);
    });

    await t.test('nullable fields, enums, and internal-field exclusions are explicit', () => {
      for (const [model, field] of [
        ['JobResponse', 'finished_at'],
        ['MediaResponse', 'duration_seconds'],
        ['AppearanceResponse', 'machine_text'],
        ['PredictionResponse', 'ocr_score'],
        ['PredictionResponse', 'character_scores'],
        ['ReviewResponse', 'corrected_text'],
      ]) {
        assert.equal(schemas[model].properties[field].nullable, true, `${model}.${field}`);
        assert.ok(
          schemas[model].required.includes(field),
          `${model}.${field} is present even when null`,
        );
      }
      assert.deepEqual(schemas.AppearanceResponse.properties.review_status.enum, [
        'pending',
        'confirmed',
        'corrected',
        'unreadable',
        'rejected',
      ]);
      assert.equal(schemas.PipelineResponse.properties.media_types.type, 'array');
      assert.deepEqual(schemas.PipelineResponse.properties.media_types.items.enum, [
        'image',
        'video',
      ]);
      const serialized = JSON.stringify(schemas);
      for (const field of [
        'password_hash',
        'token_hash',
        'storage_key',
        'pipeline_snapshot',
        'session_id',
      ])
        assert.ok(!serialized.includes(`"${field}"`), `${field} stays private`);
      assert.ok(schemas.ErrorResponse.properties.detail.oneOf.length >= 2);
      assert.equal(
        success('/api/v2/recognition-results/{id}/reviews', 'post', 409).content['application/json']
          .schema.$ref,
        '#/components/schemas/ErrorResponse',
      );
    });

    await t.test('binary, CSV and no-content routes do not advertise JSON success', () => {
      for (const [path, mime] of [
        ['/api/v2/media/{id}/content', 'video/mp4'],
        ['/api/v2/detections/{id}/artifacts/{kind}', 'image/png'],
        ['/api/v2/recognition-jobs/{id}/export', 'text/csv'],
      ]) {
        const content = success(path, 'get', 200).content;
        assert.equal(content[mime].schema.format, 'binary');
        assert.equal(content['application/json'], undefined);
      }
      assert.equal(success('/api/v2/auth/logout', 'post', 204).content, undefined);
    });

    await t.test('media ranges and operational failures are explicit', () => {
      const media = spec.paths['/api/v2/media/{id}/content'].get;
      assert.ok(media.parameters.some((p: any) => p.name === 'Range' && p.in === 'header'));
      const partial = success('/api/v2/media/{id}/content', 'get', 206);
      assert.equal(partial.content['video/mp4'].schema.format, 'binary');
      assert.ok(partial.headers['Content-Range']);
      const rangeError = success('/api/v2/media/{id}/content', 'get', 416);
      assert.ok(rangeError.headers['Content-Range']);
      assert.equal(
        rangeError.content['application/json'].schema.$ref,
        '#/components/schemas/ErrorResponse',
      );
      for (const [path, method] of [
        ['/api/v2/media', 'post'],
        ['/health/ready', 'get'],
      ])
        assert.equal(
          success(path, method, 503).content['application/json'].schema.$ref,
          '#/components/schemas/ErrorResponse',
        );
      assert.deepEqual(json('/health/ready').required, ['status', 'database']);
      assert.deepEqual(json('/health').required, ['status']);
      assert.deepEqual(json('/').required, ['message', 'framework']);
    });
  } finally {
    await app.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const safeRoot = resolve(root);
    assert.ok(safeRoot.startsWith(resolve(tmpdir()) + sep));
    await rm(safeRoot, { recursive: true, force: true });
  }
});

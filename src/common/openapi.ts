import { applyDecorators, Type } from '@nestjs/common';
import { ApiExtraModels, ApiHeader, ApiQuery, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { ErrorResponse } from './api-models';

/** Reusable response envelopes keep generated clients consistent with runtime JSON. */
export const ApiPageResponse = (model: Type<unknown>) =>
  applyDecorators(
    ApiExtraModels(model),
    ApiResponse({
      status: 200,
      schema: {
        type: 'object',
        required: ['total', 'limit', 'offset', 'items'],
        properties: {
          total: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          offset: { type: 'integer', minimum: 0 },
          items: { type: 'array', items: { $ref: getSchemaPath(model) } },
        },
      },
    }),
  );

export const ApiCollectionResponse = (model: Type<unknown>) =>
  applyDecorators(
    ApiExtraModels(model),
    ApiResponse({
      status: 200,
      schema: {
        type: 'object',
        required: ['items'],
        properties: { items: { type: 'array', items: { $ref: getSchemaPath(model) } } },
      },
    }),
  );

export const ApiFileResponse = (...mimeTypes: string[]) =>
  ApiResponse({
    status: 200,
    description: 'Authenticated file response.',
    content: Object.fromEntries(
      mimeTypes.map((mime) => [mime, { schema: { type: 'string', format: 'binary' } }]),
    ),
  });

export const ApiRangedFileResponse = (...mimeTypes: string[]) =>
  applyDecorators(
    ApiFileResponse(...mimeTypes),
    ApiHeader({
      name: 'Range',
      required: false,
      description: 'Optional byte range, for example bytes=0-1023, for media playback or seeking.',
      schema: { type: 'string' },
    }),
    ApiResponse({
      status: 206,
      description: 'Requested part of the authenticated source file.',
      headers: {
        'Content-Range': {
          description: 'Returned byte interval and full file length, e.g. bytes 0-1023/4096.',
          schema: { type: 'string' },
        },
        'Accept-Ranges': { schema: { type: 'string', enum: ['bytes'] } },
      },
      content: Object.fromEntries(
        mimeTypes.map((mime) => [mime, { schema: { type: 'string', format: 'binary' } }]),
      ),
    }),
    ApiResponse({
      status: 416,
      description: 'Requested byte range is outside the source file.',
      type: ErrorResponse,
      headers: {
        'Content-Range': {
          description: 'Available length, e.g. bytes */4096.',
          schema: { type: 'string' },
        },
      },
    }),
  );

export const ApiFailures = (...statuses: number[]) =>
  applyDecorators(...statuses.map((status) => ApiResponse({ status, type: ErrorResponse })));

export const ApiPage = () =>
  applyDecorators(
    ApiQuery({
      name: 'limit',
      required: false,
      schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    }),
    ApiQuery({
      name: 'offset',
      required: false,
      schema: { type: 'integer', minimum: 0, default: 0 },
    }),
  );

export const ApiTimeRange = (from: string, to: string) =>
  applyDecorators(
    ApiQuery({
      name: from,
      required: false,
      description: 'Inclusive ISO 8601 instant with timezone',
      schema: { type: 'string', format: 'date-time' },
    }),
    ApiQuery({
      name: to,
      required: false,
      description: 'Inclusive ISO 8601 instant with timezone',
      schema: { type: 'string', format: 'date-time' },
    }),
  );

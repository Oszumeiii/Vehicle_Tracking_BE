import {
  ArgumentsHost,
  UnprocessableEntityException,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { z, ZodError } from 'zod';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';

export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export const instant = z.iso.datetime({ offset: true }).optional();
export const id = z.string().regex(/^[0-9a-f]{32}$/);
export const newId = () => randomUUID().replaceAll('-', '');
export const normalizePlate = (text: string) => text.toUpperCase().replace(/[\s-]+/g, '');
export type Actor = {
  id: string;
  email: string;
  display_name: string;
  role: 'admin' | 'user';
  is_active: boolean;
  created_at: Date;
  session_id?: string;
};

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(value);
}
export function checkDates(from?: string, to?: string) {
  if (from && to && new Date(from) > new Date(to))
    throw new UnprocessableEntityException('Start time exceeds end time.');
}

@Catch()
export class ApiErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) return;
    // sendFile may already have selected an image/video MIME before rejecting
    // a range. All API errors still use the JSON error contract.
    res.type('application/json');
    if (
      error instanceof Error &&
      error.name === 'RangeNotSatisfiableError' &&
      (error as Error & { status?: number }).status === 416
    ) {
      res.status(416).json({ detail: 'Requested byte range is outside the file.' });
      return;
    }
    if (error instanceof ZodError) {
      res
        .status(422)
        .json({ detail: error.issues.map((i) => ({ path: i.path, message: i.message })) });
      return;
    }
    if (error instanceof HttpException) {
      const body = error.getResponse();
      if (error.getStatus() === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(error.getStatus()).json({
        detail: typeof body === 'string' ? body : ((body as { message?: unknown }).message ?? body),
      });
      return;
    }
    const code = (error as { code?: string })?.code;
    if (code === '23505' || code === '23503' || code === '23001') {
      res.status(409).json({
        detail: code === '23505' ? 'Resource already exists.' : 'Resource is still referenced.',
      });
      return;
    }
    Logger.error(error instanceof Error ? error.stack : error, 'HTTP');
    res.status(500).json({ detail: 'Internal server error.' });
  }
}

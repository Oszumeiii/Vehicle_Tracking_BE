import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module';
import { ApiErrors } from './common/http';
import { settings } from './common/config';

export async function createApp() {
  await mkdir(resolve(settings().dataDir, 'media'), { recursive: true });
  const app = await NestFactory.create(AppModule, {
    logger: process.env.NODE_ENV === 'test' ? false : ['log', 'warn', 'error'],
    abortOnError: false,
  });
  app.useGlobalFilters(new ApiErrors());
  app.use('/api', (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  const origins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (origins.length)
    app.enableCors({
      origin: origins,
      exposedHeaders: ['Content-Disposition', 'Content-Range', 'Accept-Ranges'],
    });
  app.enableShutdownHooks();
  const spec = new DocumentBuilder()
    .setTitle('Low-resolution License Plate Recognition')
    .setDescription(
      'NestJS + PostgreSQL. Authenticated v2 recognition/review/search and compatible v1 extraction.',
    )
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, spec));
  await app.init();
  return app;
}
export async function bootstrap() {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be an integer from 1 to 65535.');
  const app = await createApp();
  try {
    await app.listen(port, process.env.HOST ?? '127.0.0.1');
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

if (require.main === module) {
  void bootstrap().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

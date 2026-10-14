import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { DatabaseModule } from './database/database.module';
import { Database } from './database/database';
import { assertCurrentMigrations } from './database/migrate';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { Ownership } from './common/ownership';
import { Storage } from './media/storage';
import { MediaController } from './media/media.controller';
import { JobsController, JobOperations } from './jobs/jobs.controller';
import { ResultsController } from './results/results.controller';
import { PipelineRegistry } from './recognition/registry';
import { ApiFailures } from './common/openapi';

@ApiTags('Health')
@Controller()
class HealthController {
  constructor(private db: Database) {}
  @Get()
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      required: ['message', 'framework'],
      properties: {
        message: { type: 'string' },
        framework: { type: 'string', enum: ['NestJS'] },
      },
    },
  })
  root() {
    return { message: 'Low-resolution License Plate Recognition API', framework: 'NestJS' };
  }
  @Get('health')
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      required: ['status'],
      properties: { status: { type: 'string', enum: ['ok'] } },
    },
  })
  health() {
    return { status: 'ok' };
  }
  @Get('health/ready')
  @ApiResponse({
    status: 200,
    description: 'PostgreSQL is reachable and the schema matches every bundled migration.',
    schema: {
      type: 'object',
      required: ['status', 'database'],
      properties: {
        status: { type: 'string', enum: ['ok'] },
        database: { type: 'string', enum: ['postgresql'] },
      },
    },
  })
  @ApiFailures(503)
  async ready() {
    try {
      await assertCurrentMigrations(this.db);
      await this.db.query('SELECT 1 FROM recognition_jobs LIMIT 0');
      return { status: 'ok', database: 'postgresql' };
    } catch {
      throw new ServiceUnavailableException('Database is unavailable or not migrated.');
    }
  }
}

@Module({
  imports: [DatabaseModule],
  controllers: [
    HealthController,
    AuthController,
    MediaController,
    JobsController,
    ResultsController,
  ],
  providers: [AuthGuard, Ownership, Storage, JobOperations, PipelineRegistry],
})
export class AppModule {}

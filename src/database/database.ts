import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/** PostgreSQL connection boundary shared by the API, worker and CLI. */
@Injectable()
export class Database implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(@Optional() @Inject('DATABASE_URL') connectionString?: string) {
    const url = connectionString ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL must point to a PostgreSQL database.');
    }
    if (!/^postgres(?:ql)?:\/\//i.test(url)) {
      throw new Error('DATABASE_URL must use the postgres:// or postgresql:// scheme.');
    }
    this.pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 10_000 });
    // A lost idle connection should not crash the API process. Queries still reject
    // normally, so callers can report a failed operation rather than a false success.
    this.pool.on('error', (error) => {
      console.error('PostgreSQL idle connection error:', error.message);
    });
  }

  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, values);
  }

  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let releaseError: Error | undefined;
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        releaseError =
          rollbackError instanceof Error ? rollbackError : new Error('Rollback failed');
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

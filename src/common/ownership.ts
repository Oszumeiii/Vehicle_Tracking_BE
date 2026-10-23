import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { Database } from '../database/database';
import { Actor } from './http';
import type { QueryResult } from 'pg';
interface Queryable {
  query(text: string, values?: any[]): Promise<QueryResult>;
}

/**
 * A job belongs to the owner of its uploaded media or of its live session's camera.
 * Callers bind $1 = is admin and $2 = actor id and filter with JOB_OWNER.
 */
export const JOB_SOURCES = `recognition_jobs j
  LEFT JOIN media_assets m ON m.id=j.media_id
  LEFT JOIN live_sessions s ON s.id=j.live_session_id
  LEFT JOIN stream_sources c ON c.id=s.stream_source_id`;
export const JOB_OWNER = '($1::boolean OR coalesce(m.owner_id,c.owner_id)=$2)';

@Injectable()
export class Ownership {
  constructor(private db: Database) {}
  async media(actor: Actor, id: string, c: Queryable = this.db, lock = false) {
    const row = (
      await c.query(
        `SELECT * FROM media_assets WHERE id=$1 AND ($2::boolean OR owner_id=$3) ${lock ? 'FOR UPDATE' : ''}`,
        [id, actor.role === 'admin', actor.id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException('Media not found.');
    return row;
  }
  async job(actor: Actor, id: string, ready = false, c: Queryable = this.db) {
    const row = (
      await c.query(`SELECT j.* FROM ${JOB_SOURCES} WHERE j.id=$3 AND ${JOB_OWNER}`, [
        actor.role === 'admin',
        actor.id,
        id,
      ])
    ).rows[0];
    if (!row) throw new NotFoundException('Job not found.');
    if (ready && row.status !== 'succeeded')
      throw new ConflictException('Results are available only for succeeded jobs.');
    return row;
  }
  async result(actor: Actor, id: string, c: Queryable = this.db, lock = false) {
    const row = (
      await c.query(
        `SELECT a.* FROM plate_appearances a JOIN ${JOB_SOURCES} ON j.id=a.job_id
      WHERE a.id=$3 AND j.status='succeeded' AND ${JOB_OWNER} ${lock ? 'FOR UPDATE OF a' : ''}`,
        [actor.role === 'admin', actor.id, id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException('Result not found.');
    return row;
  }
  async streamSource(actor: Actor, id: string, c: Queryable = this.db, lock = false) {
    const row = (
      await c.query(
        `SELECT * FROM stream_sources WHERE id=$1 AND ($2::boolean OR owner_id=$3) ${lock ? 'FOR UPDATE' : ''}`,
        [id, actor.role === 'admin', actor.id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException('Stream source not found.');
    return row;
  }
  async liveSession(actor: Actor, id: string, c: Queryable = this.db, lock = false) {
    const row = (
      await c.query(
        `SELECT s.*, c.owner_id FROM live_sessions s JOIN stream_sources c ON c.id=s.stream_source_id
        WHERE s.id=$1 AND ($2::boolean OR c.owner_id=$3) ${lock ? 'FOR UPDATE OF s' : ''}`,
        [id, actor.role === 'admin', actor.id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException('Live session not found.');
    return row;
  }
}

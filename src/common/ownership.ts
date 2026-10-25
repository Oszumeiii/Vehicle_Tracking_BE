import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { Database } from '../database/database';
import { Actor } from './http';
import type { QueryResult } from 'pg';
interface Queryable {
  query(text: string, values?: any[]): Promise<QueryResult>;
}

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
      await c.query(
        `SELECT j.* FROM recognition_jobs j JOIN media_assets m ON m.id=j.media_id WHERE j.id=$1 AND ($2::boolean OR m.owner_id=$3)`,
        [id, actor.role === 'admin', actor.id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException('Job not found.');
    if (ready && row.status !== 'succeeded')
      throw new ConflictException('Results are available only for succeeded jobs.');
    return row;
  }
  async result(actor: Actor, id: string, c: Queryable = this.db, lock = false) {
    const row = (
      await c.query(
        `SELECT a.*, j.media_id, m.media_type, m.duration_seconds AS media_duration_seconds, m.original_name AS media_original_name,
           (SELECT d.id FROM plate_detections d WHERE d.appearance_id=a.id ORDER BY d.selected_order,d.id LIMIT 1) AS primary_detection_id,
           (SELECT d.bbox FROM plate_detections d WHERE d.appearance_id=a.id ORDER BY d.selected_order,d.id LIMIT 1) AS primary_bbox,
           (SELECT d.crop_bbox FROM plate_detections d WHERE d.appearance_id=a.id ORDER BY d.selected_order,d.id LIMIT 1) AS primary_crop_bbox
         FROM plate_appearances a JOIN recognition_jobs j ON j.id=a.job_id JOIN media_assets m ON m.id=j.media_id
         WHERE a.id=$1 AND j.status='succeeded' AND ($2::boolean OR m.owner_id=$3) ${lock ? 'FOR UPDATE OF a' : ''}`,
        [id, actor.role === 'admin', actor.id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException('Result not found.');
    return row;
  }
}

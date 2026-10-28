import type { QueryResult } from 'pg';

interface Queryable {
  query(text: string, values?: any[]): Promise<QueryResult>;
}

/** Confidence bins for stratified sampling; the last bin holds 0.95-1. */
export const BINS = [0, 0.5, 0.7, 0.8, 0.85, 0.9, 0.95, 1.000001];

export interface SampledTrack {
  job_id: string;
  result_id: string;
  machine_text: string | null;
  stream_source_id: string;
  confidence: number;
  bin: number;
}

/**
 * Up to perBin random live tracks of a camera or session from each confidence bin,
 * so precision can be measured near every candidate threshold, not only where most
 * tracks fall. Tracks without a confidence are skipped; with minCropWidth, so are tracks
 * whose median crop is narrower (plates too small for a person to read).
 */
export async function sampleLiveTracks(
  db: Queryable,
  filter: { source?: string; session?: string },
  perBin: number,
  minCropWidth?: number,
): Promise<SampledTrack[]> {
  const rows = (
    await db.query(
      `SELECT j.id AS job_id, a.id AS result_id, a.machine_text, s.stream_source_id,
        (j.statistics->>'confidence')::float AS confidence
      FROM recognition_jobs j JOIN plate_appearances a ON a.job_id=j.id
      JOIN live_sessions s ON s.id=j.live_session_id
      WHERE (($1::text IS NOT NULL AND s.stream_source_id=$1) OR ($2::text IS NOT NULL AND j.live_session_id=$2))
        AND j.statistics->>'confidence' IS NOT NULL
        AND ($3::int IS NULL OR (
          SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY d.crop_width)
          FROM plate_detections d WHERE d.appearance_id=a.id) >= $3)
      ORDER BY random()`,
      [filter.source ?? null, filter.session ?? null, minCropWidth ?? null],
    )
  ).rows;
  return BINS.slice(1).flatMap((upper, bin) =>
    rows
      .filter((row) => row.confidence >= BINS[bin] && row.confidence < upper)
      .slice(0, perBin)
      .map((row) => ({ ...row, bin })),
  );
}

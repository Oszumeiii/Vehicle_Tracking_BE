import { UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { normalizePlate } from '../common/http';

export const plateMatch = z.enum(['exact', 'contains', 'fuzzy']);
export type PlateMatch = z.infer<typeof plateMatch>;

/** Plate text as stored: uppercase, without spaces, hyphens or dots ("43A-123.45" -> "43A12345"). */
export function plateQuery(text: string) {
  const plate = normalizePlate(text);
  if (!plate) throw new UnprocessableEntityException('Plate query cannot be empty.');
  return plate;
}

/**
 * Edits allowed by an approximate search, after folding look-alike characters:
 * none under 5 characters (too many plates would match), 1 up to 7, 2 from 8.
 * Watchlist matching uses the same "one off from 5 characters" rule.
 */
export function fuzzyEdits(plate: string) {
  return plate.length < 5 ? 0 : plate.length < 8 ? 1 : 2;
}

/**
 * SQL condition on `column` for a plate query, binding its values into `values`.
 * `distance` is the SQL of the edit distance to the query (null unless fuzzy), for
 * ordering and for showing how far a fuzzy match is from what was typed.
 */
export function plateClause(
  match: PlateMatch,
  plate: string,
  values: unknown[],
  column = 'a.effective_text',
) {
  if (match === 'contains') {
    values.push(`%${plate}%`);
    return { where: `${column} LIKE $${values.length}`, distance: null };
  }
  values.push(plate);
  const query = `$${values.length}::text`;
  if (match === 'exact') return { where: `${column}=${query}`, distance: null };
  const edits = fuzzyEdits(plate);
  return {
    where:
      `abs(length(${column})-length(${query}))<=${edits} AND ` +
      `levenshtein(plate_skeleton(${column}),plate_skeleton(${query}))<=${edits}`,
    distance: `levenshtein(${column},${query})`,
  };
}

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
 * plate_skeleton() of migration 0016 for one plate: an old-format Brazilian letter in a
 * 7-character plate's fifth place becomes its Mercosul digit (A=0 ... J=9), then
 * look-alikes fold (O, D, Q -> 0; I, L -> 1; Z -> 2; S -> 5; B -> 8; G -> 6).
 */
export function plateSkeleton(text: string) {
  let plate = text.toUpperCase();
  if (plate.length === 7 && plate[4] >= 'A' && plate[4] <= 'J')
    plate = plate.slice(0, 4) + String.fromCharCode(plate.charCodeAt(4) - 17) + plate.slice(5);
  return plate.replace(/[ODQILZSBG]/g, (c) => '000112586'['ODQILZSBG'.indexOf(c)]);
}

/** Every character plate_skeleton() can put out: digits and the letters it keeps. */
const SKELETON_CHARACTERS = '0123456789ACEFHJKMNPRTUVWXY';

/** Every skeleton at most one edit (insertion, deletion, substitution) away from `skeleton`. */
export function oneEditAway(skeleton: string) {
  const near = new Set([skeleton]);
  for (let i = 0; i <= skeleton.length; i++) {
    if (i < skeleton.length) near.add(skeleton.slice(0, i) + skeleton.slice(i + 1));
    for (const c of SKELETON_CHARACTERS) {
      near.add(skeleton.slice(0, i) + c + skeleton.slice(i));
      if (i < skeleton.length) near.add(skeleton.slice(0, i) + c + skeleton.slice(i + 1));
    }
  }
  return [...near];
}

/**
 * SQL condition on `column` for a plate query, binding its values into `values`.
 * `distance` is the SQL of the edit distance to the query (null unless fuzzy), for
 * ordering and for showing how far a fuzzy match is from what was typed.
 *
 * Index use (docs/EVALUATION.md, "Thử tải"): exact uses the plate index; contains the
 * trigram index (migration 0021, fragments of 3+ characters); fuzzy up to one edit
 * looks up every skeleton one edit away (a few hundred) in the skeleton index instead of
 * comparing every stored read. Two edits (plates of 8+ characters) still compare all reads.
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
  const distance = `levenshtein(${column},${query})`;
  if (edits <= 1) {
    // The length test is implied (a skeleton keeps the plate's length) but keeps the query
    // parameter in every statement: a count without `distance` must still bind it.
    values.push(edits ? oneEditAway(plateSkeleton(plate)) : [plateSkeleton(plate)]);
    return {
      where:
        `plate_skeleton(${column})=ANY($${values.length}::text[]) AND ` +
        `abs(length(${column})-length(${query}))<=${edits}`,
      distance,
    };
  }
  return {
    where:
      `abs(length(${column})-length(${query}))<=${edits} AND ` +
      `levenshtein(plate_skeleton(${column}),plate_skeleton(${query}))<=${edits}`,
    distance,
  };
}

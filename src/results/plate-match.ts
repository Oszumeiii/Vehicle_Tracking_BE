import { UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { normalizePlate } from '../common/http';
import { CONFUSION_PAIRS } from './confusions';

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

/** A 7-character plate's fifth letter A-J as its digit (ABC1C34 -> ABC1234). */
export function plateMercosul(text: string) {
  const plate = text.toUpperCase();
  return plate.length === 7 && plate[4] >= 'A' && plate[4] <= 'J'
    ? plate.slice(0, 4) + String.fromCharCode(plate.charCodeAt(4) - 17) + plate.slice(5)
    : plate;
}

/** Every spelling with the plate's plateMercosul(): as typed, and the other Brazilian format. */
export function plateTwins(plate: string) {
  if (plate.length !== 7) return [plate];
  const digit = plateMercosul(plate);
  const fifth = digit[4];
  if (fifth < '0' || fifth > '9') return [plate];
  return [
    digit,
    digit.slice(0, 4) + String.fromCharCode(fifth.charCodeAt(0) + 17) + digit.slice(5),
  ];
}

/** The two characters (sorted) of the one place where equal-length plates differ, else null. */
export function oneSwap(a: string, b: string) {
  if (a.length !== b.length) return null;
  let swap: string | null = null;
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i]) {
      if (swap) return null;
      swap = [a[i], b[i]].sort().join('');
    }
  return swap;
}

/**
 * Every spelling one often-confused character away from the plate (matchReason
 * "confusable"), in both Brazilian formats. Letters and digits only: they go into SQL.
 */
export function confusableSpellings(plate: string) {
  const mercosul = plateMercosul(plate);
  const spellings = new Set<string>();
  for (let i = 0; i < mercosul.length; i++)
    for (const pair of CONFUSION_PAIRS) {
      const at = pair.indexOf(mercosul[i]);
      if (at < 0) continue;
      const swapped = mercosul.slice(0, i) + pair[1 - at] + mercosul.slice(i + 1);
      // A fifth letter A-J is the other format of another plate, not this swap.
      if (plateMercosul(swapped) === swapped)
        for (const spelling of plateTwins(swapped)) spellings.add(spelling);
    }
  return [...spellings].filter((spelling) => /^[A-Z0-9]+$/.test(spelling));
}

export type MatchReason = 'same' | 'alternative' | 'confusable' | 'near';

/**
 * Why a reading matched an approximate search, and how likely it is the searched plate
 * (score, lower first; docs/EVALUATION.md "Tìm kiếm xấp xỉ"):
 * - same (0): the same plate, or its other Brazilian format (ABC1234 = ABC1C34);
 * - alternative (1 - p): the model weighed the searched plate as an alternative reading
 *   with probability p (plate_candidates; reviewed readings have none);
 * - confusable (1.5): one character off, by a pair the models often confuse (CONFUSION_PAIRS);
 * - near (2): any other reading the fuzzy rule lets through.
 * On labelled ICPR tracks, 77% of the true near matches were model alternatives against 5%
 * of the wrong ones; a confusable character separated them less (66% against 20%).
 * plateClause computes the same score in SQL.
 */
export function matchReason(
  stored: string,
  query: string,
  probability: number | null,
): { reason: MatchReason; score: number } {
  if (plateMercosul(stored) === plateMercosul(query)) return { reason: 'same', score: 0 };
  if (probability !== null) return { reason: 'alternative', score: 1 - probability };
  const swap = oneSwap(plateMercosul(stored), plateMercosul(query));
  return swap && CONFUSION_PAIRS.includes(swap)
    ? { reason: 'confusable', score: 1.5 }
    : { reason: 'near', score: 2 };
}

/**
 * SQL condition on `column` for a plate query, binding its values into `values`.
 * For match=fuzzy also the SQL of the match's fields (fuzzyFields): `distance` (edit
 * distance to the query), `probability` (of the model alternative that matched, else NULL)
 * and `score` as matchReason(), for ordering. `appearance` is the alias of
 * plate_appearances, whose model alternatives (plate_candidates) also match while unreviewed.
 *
 * Index use (docs/EVALUATION.md, "Thử tải"): exact uses the plate index; contains the
 * trigram index (migration 0021, fragments of 3+ characters); fuzzy up to one edit
 * looks up every skeleton one edit away (a few hundred) in the skeleton index instead of
 * comparing every stored read, and the alternatives in their text index. Two edits (plates
 * of 8+ characters) still compare all reads.
 */
export function plateClause(
  match: PlateMatch,
  plate: string,
  values: unknown[],
  column = 'a.effective_text',
  appearance = 'a',
) {
  if (match === 'contains') {
    values.push(`%${plate}%`);
    return { where: `${column} LIKE $${values.length}`, fuzzy: null };
  }
  values.push(plate);
  const query = `$${values.length}::text`;
  if (match === 'exact') return { where: `${column}=${query}`, fuzzy: null };
  const edits = fuzzyEdits(plate);
  // The length test is implied when edits <= 1 (a skeleton keeps the plate's length) but
  // keeps the query parameter in every statement: a count without the fields must bind it.
  let near: string;
  if (edits <= 1) {
    values.push(edits ? oneEditAway(plateSkeleton(plate)) : [plateSkeleton(plate)]);
    near =
      `plate_skeleton(${column})=ANY($${values.length}::text[]) AND ` +
      `abs(length(${column})-length(${query}))<=${edits}`;
  } else
    near =
      `abs(length(${column})-length(${query}))<=${edits} AND ` +
      `levenshtein(plate_skeleton(${column}),plate_skeleton(${query}))<=${edits}`;
  values.push(plateTwins(plate));
  const twins = `$${values.length}::text[]`;
  // ARRAY(...) runs once, so each arm of the OR has its own index (skeleton, primary key).
  const alternative =
    `${appearance}.review_status='pending' AND ${appearance}.id=ANY(ARRAY(` +
    `SELECT c.appearance_id FROM plate_candidates c WHERE c.text=ANY(${twins})))`;
  const probability =
    `(SELECT max(c.probability) FROM plate_candidates c WHERE c.appearance_id=${appearance}.id ` +
    `AND c.text=ANY(${twins}) AND ${appearance}.review_status='pending')`;
  // Spelled out (letters and digits only) rather than bound: a count binds every value, and
  // one it does not use has no type.
  const confusable = `ARRAY[${confusableSpellings(plate)
    .map((spelling) => `'${spelling}'`)
    .join(',')}]::text[]`;
  return {
    where: `((${near}) OR (${alternative}))`,
    fuzzy: {
      distance: `levenshtein(${column},${query})`,
      probability,
      score:
        `(CASE WHEN ${column}=ANY(${twins}) THEN 0 ELSE coalesce(1-${probability}, ` +
        `CASE WHEN ${column}=ANY(${confusable}) THEN 1.5 ELSE 2 END) END)::real`,
    },
  };
}

/** The SELECT list items of plateClause's fuzzy fields, named as the API returns them. */
export function fuzzyFields(fuzzy: NonNullable<ReturnType<typeof plateClause>['fuzzy']>) {
  return (
    `${fuzzy.distance} AS match_distance,${fuzzy.score} AS match_score,` +
    `${fuzzy.probability} AS match_probability`
  );
}

/**
 * A row with fuzzyFields, completed with match_reason (as matchReason) and its probability
 * kept only for an alternative. Rows of other searches are returned as they are.
 */
export function withMatchReason<T extends Record<string, any>>(row: T) {
  if (row.match_score === undefined || row.match_score === null) return row;
  const reason: MatchReason =
    row.match_score === 0
      ? 'same'
      : row.match_probability !== null
        ? 'alternative'
        : row.match_score < 2
          ? 'confusable'
          : 'near';
  return {
    ...row,
    match_reason: reason,
    match_probability: reason === 'alternative' ? row.match_probability : null,
  };
}

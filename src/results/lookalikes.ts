import { CONFUSION_PAIRS } from './confusions';
import { plateTwins } from './plate-forms';

/**
 * Characters a plate reader confuses, as sorted pairs ("18" is 1<->8):
 * - shape: they look alike on a small, blurred plate (hand-made: I/1, O/0, B/8, S/5...);
 * - ocr: the OCR models confused them on the ICPR validation tracks (CONFUSION_PAIRS).
 * Pairs, not classes: 1 is like I and I like L, but that does not make 1 a look-alike of
 * every letter like L. Approximate search (match=similar, /plates/{plate}/similar) tries the
 * spellings these substitutions make.
 */
const SHAPE_PAIRS = (
  '0O 0D 0Q 0U 1I 1L 1T 1J 17 2Z 27 38 3B 8B 5S 6G 6C 4A 9G ' +
  'DO OQ IL IT CG EF PR MN HM HN MW VY UV KX'
).split(' ');

export type LookalikeKind = 'shape' | 'ocr' | 'mercosul';

/** Each pair with what makes it confusable (both kinds when hand-made and measured agree). */
export const LOOKALIKE_PAIRS: readonly { pair: string; kinds: LookalikeKind[] }[] = (() => {
  const kinds = new Map<string, LookalikeKind[]>();
  const add = (pair: string, kind: LookalikeKind) => {
    const key = [...pair].sort().join('');
    kinds.set(key, [...(kinds.get(key) ?? []), kind]);
  };
  for (const pair of SHAPE_PAIRS) add(pair, 'shape');
  for (const pair of CONFUSION_PAIRS) add(pair, 'ocr');
  return [...kinds].map(([pair, list]) => ({ pair, kinds: list }));
})();

/** For each character, the characters it can be confused with and why. */
const PARTNERS = new Map<string, { to: string; kinds: LookalikeKind[] }[]>();
for (const { pair, kinds } of LOOKALIKE_PAIRS)
  for (const [from, to] of [
    [pair[0], pair[1]],
    [pair[1], pair[0]],
  ]) {
    PARTNERS.set(from, [...(PARTNERS.get(from) ?? []), { to, kinds }]);
  }

/** One character of the searched plate read as another. */
export interface Change {
  index: number;
  from: string;
  to: string;
  /** Why the two are confusable; `mercosul`: the other Brazilian format of the same plate. */
  kinds: LookalikeKind[];
}

/** Characters changed by look-alikes; the Mercosul spelling of the same plate counts none. */
export const changeCount = (changes: Change[]) =>
  changes.filter((change) => !change.kinds.includes('mercosul')).length;

/** Most look-alike characters an approximate search changes (a few hundred spellings at 2). */
export const MAX_CHANGES = 3;
export const DEFAULT_CHANGES = 2;

/**
 * Every spelling of `plate` with at most `maxChanges` characters replaced by a look-alike
 * (LOOKALIKE_PAIRS), each character at most once, with the changes that make it; also the
 * plate's other Brazilian format (ABC1234 = ABC1C34) and its look-alikes. Ordered by the
 * number of changes (the plate first). Plates under 5 characters get no look-alikes: too many
 * would match. Only letters and digits are changed.
 */
export function similarSpellings(plate: string, maxChanges = DEFAULT_CHANGES) {
  const spellings = new Map<string, Change[]>();
  let frontier: [string, Change[]][] = plateTwins(plate).map((spelling) => [
    spelling,
    spelling === plate
      ? []
      : [{ index: 4, from: plate[4], to: spelling[4], kinds: ['mercosul'] as LookalikeKind[] }],
  ]);
  // The plate as typed first, then its other format.
  frontier.sort((a, b) => a[1].length - b[1].length);
  for (const [spelling, changes] of frontier) spellings.set(spelling, changes);
  const depth = plate.length < 5 ? 0 : Math.min(Math.max(0, maxChanges), MAX_CHANGES);
  for (let round = 0; round < depth; round++) {
    const next: [string, Change[]][] = [];
    for (const [spelling, changes] of frontier)
      for (let i = 0; i < spelling.length; i++) {
        // Each character changes once (a Mercosul fifth letter is not read as a look-alike too).
        if (changes.some((change) => change.index === i)) continue;
        for (const { to, kinds } of PARTNERS.get(spelling[i]) ?? []) {
          const changed = spelling.slice(0, i) + to + spelling.slice(i + 1);
          if (spellings.has(changed)) continue;
          const made = [...changes, { index: i, from: spelling[i], to, kinds }].sort(
            (a, b) => a.index - b.index,
          );
          spellings.set(changed, made);
          next.push([changed, made]);
        }
      }
    frontier = next;
  }
  return spellings;
}

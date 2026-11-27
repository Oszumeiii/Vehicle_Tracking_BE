/**
 * Character pairs the OCR models confuse most on low-resolution plates, each sorted
 * ("68" is 6<->8), most frequent first: the substitutions seen at least 6 times in the
 * same-length misreads of SE-ResNet34-C and SVTRv2 on the 1000 ICPR validation tracks (61%
 * of all substitutions; `node scripts/eval_candidates.mjs --confusions`, docs/EVALUATION.md
 * "Tìm kiếm xấp xỉ").
 *
 * Measured, not guessed: the look-alike folding of plate_skeleton() (O/D/Q=0, I/L=1, ...)
 * covers few of the real errors, because a Brazilian plate fixes where letters and digits
 * go and the decoder keeps to that format. The list only orders and explains approximate
 * matches (plateClause, matchReason); it never widens what matches.
 */
export const CONFUSION_PAIRS: readonly string[] = (
  '68 HM 46 OQ 56 59 89 13 VY 23 08 HN AB BD 58 BR DQ ' +
  'DO VW 12 17 27 35 BH 02 45 69 79 CE NW 03 MN VX TY'
).split(' ');

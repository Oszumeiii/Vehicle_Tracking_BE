// How much the decoder's alternative readings help a plate search, on labelled tracks.
//
//   npm run build
//   node scripts/eval_candidates.mjs data/evaluation/icpr/candidates/r34c-test/readings.json
//
// Input: readings.json of scripts/calibrate_icpr.py (each row: plate_text = the truth,
// machine_text = the model's reading, candidates = the readings the beam weighed, best first).
// Every track's truth is searched for among every track's reading, as the search does:
//   exact            the reading equals the plate;
//   fuzzy            match=fuzzy as today (plateClause: look-alikes folded, Mercosul fifth
//                    character, one edit for plates of 5-7 characters);
//   fuzzy+alt        fuzzy, or one of the reading's alternatives (from --min-probability) is
//                    the plate or its Mercosul twin.
// "Wrong per search" counts tracks of another plate a search also returns. Prints a JSON
// report; --confusions prints the substitution pairs of same-length misreads instead;
// --similar scores match=similar (look-alike spellings, src/results/lookalikes.ts) at 1-3
// changed characters.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fuzzyEdits, plateSkeleton } from '../dist/src/results/plate-match.js';
import { similarSpellings } from '../dist/src/results/lookalikes.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'min-probability': { type: 'string', default: '0.02' },
    confusions: { type: 'boolean', default: false },
    similar: { type: 'boolean', default: false },
  },
});
if (positionals.length !== 1) {
  console.error(
    'usage: node scripts/eval_candidates.mjs [--min-probability 0.02] [--confusions | --similar] readings.json',
  );
  process.exit(2);
}
const minProbability = Number(values['min-probability']);
const rows = JSON.parse(readFileSync(positionals[0], 'utf8')).rows.map((row) => ({
  truth: row.plate_text.toUpperCase().replace(/[\s.-]/g, ''),
  read: row.machine_text ?? '',
  candidates: row.candidates ?? [],
}));

/** The plate as stored once its Mercosul fifth letter is a digit (ABC1C34 -> ABC1234). */
const mercosul = (plate) =>
  plate.length === 7 && plate[4] >= 'A' && plate[4] <= 'J'
    ? plate.slice(0, 4) + String.fromCharCode(plate.charCodeAt(4) - 17) + plate.slice(5)
    : plate;

function levenshtein(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] !== b[j - 1]));
      best = Math.min(best, current[j]);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

if (values.confusions) {
  // Same-length misreads only: which character the model put in place of which.
  const pairs = new Map();
  for (const { truth, read } of rows) {
    if (read === truth || read.length !== truth.length) continue;
    for (let i = 0; i < truth.length; i++)
      if (truth[i] !== read[i]) {
        const key = [truth[i], read[i]].sort().join('');
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
  }
  console.log(JSON.stringify(Object.fromEntries([...pairs].sort((a, b) => b[1] - a[1]))));
  process.exit(0);
}

if (values.similar) {
  // A search for each track's truth finds the reads among its look-alike spellings.
  const share = (count) => Math.round((count / rows.length) * 1000) / 10;
  const report = [];
  for (const changes of [1, 2, 3]) {
    let found = 0;
    let wrong = 0;
    for (const { truth, read } of rows) {
      const spellings = similarSpellings(truth, changes);
      if (spellings.has(read)) found++;
      for (const other of rows) if (other.truth !== truth && spellings.has(other.read)) wrong++;
    }
    report.push({
      max_changes: changes,
      found_percent: share(found),
      wrong_per_search: Math.round((wrong / rows.length) * 1000) / 1000,
    });
  }
  const exact = rows.filter((row) => row.read === row.truth).length;
  console.log(JSON.stringify({ tracks: rows.length, exact_percent: share(exact), similar: report }, null, 1));
  process.exit(0);
}

const skeletons = rows.map((row) => plateSkeleton(row.read));
const fuzzy = (query, index) => {
  const edits = fuzzyEdits(query);
  return levenshtein(plateSkeleton(query), skeletons[index], edits) <= edits && rows[index].read !== '';
};
// Alternatives (the chosen reading excluded) a search can find, by Mercosul-folded text.
const alternatives = new Map();
rows.forEach((row, index) => {
  for (const candidate of row.candidates.slice(1))
    if (candidate.probability >= minProbability) {
      const key = mercosul(candidate.text);
      if (!alternatives.has(key)) alternatives.set(key, new Set());
      alternatives.get(key).add(index);
    }
});
const viaAlternative = (query, index) => alternatives.get(mercosul(query))?.has(index) ?? false;

const share = (count) => Math.round((count / rows.length) * 10000) / 100;
const found = { exact: 0, fuzzy: 0, fuzzy_alt: 0 };
const wrong = { exact: 0, fuzzy: 0, fuzzy_alt: 0 };
rows.forEach(({ truth }, i) => {
  if (rows[i].read === truth) found.exact++;
  if (fuzzy(truth, i)) found.fuzzy++;
  if (fuzzy(truth, i) || viaAlternative(truth, i)) found.fuzzy_alt++;
  rows.forEach((other, j) => {
    if (other.truth === truth) return;
    if (other.read === truth) wrong.exact++;
    const f = fuzzy(truth, j);
    if (f) wrong.fuzzy++;
    if (f || viaAlternative(truth, j)) wrong.fuzzy_alt++;
  });
});

// Is the truth among the first k readings the decoder weighed (whatever their probability)?
const topK = Object.fromEntries(
  [1, 2, 3, 5].map((k) => [
    `top_${k}`,
    share(rows.filter((row) => row.candidates.slice(0, k).some((c) => c.text === row.truth)).length),
  ]),
);

// How often a reading with a given share of the beam is the truth (calibration).
const BUCKETS = [0, 0.02, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0001];
const calibration = (pick) =>
  BUCKETS.slice(0, -1).map((low, b) => {
    const high = BUCKETS[b + 1];
    const items = rows.flatMap((row) =>
      pick(row.candidates).filter((c) => c.probability >= low && c.probability < high).map((c) => c.text === row.truth),
    );
    return {
      probability: `${low}-${Math.min(high, 1)}`,
      readings: items.length,
      truth: items.length ? Math.round((items.filter(Boolean).length / items.length) * 1000) / 1000 : null,
    };
  });

console.log(
  JSON.stringify(
    {
      tracks: rows.length,
      min_probability: minProbability,
      found_percent: { exact: share(found.exact), fuzzy: share(found.fuzzy), fuzzy_alt: share(found.fuzzy_alt) },
      wrong_per_search: Object.fromEntries(
        Object.entries(wrong).map(([key, value]) => [key, Math.round((value / rows.length) * 1000) / 1000]),
      ),
      truth_in_candidates_percent: topK,
      alternatives_per_track:
        Math.round(([...alternatives.values()].reduce((sum, set) => sum + set.size, 0) / rows.length) * 100) / 100,
      calibration_chosen: calibration((candidates) => candidates.slice(0, 1)),
      calibration_alternatives: calibration((candidates) => candidates.slice(1)),
    },
    null,
    1,
  ),
);

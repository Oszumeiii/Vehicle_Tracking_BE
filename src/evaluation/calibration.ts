import { normalizePlate } from '../recognition/fusion';

export interface LabelledItem {
  item_id: string;
  job_id: string;
  bin: number;
  machine_text: string | null;
  confidence: number | null;
  /** Each labeller's reading; null when a person could not read the plate either. */
  labels: (string | null)[];
}

const thresholdGrid = () =>
  Array.from({ length: 50 }, (_, i) => Math.round((0.5 + i * 0.01) * 100) / 100);

/**
 * Precision and coverage of the live "readable" status at each confidence threshold,
 * the same rule as app/evaluation.calibrate_threshold: a track counts as readable when
 * it has text and confidence >= threshold, and as correct when its text equals the
 * label exactly (a plate no person could read makes any text wrong). Ground truth per
 * item is the labellers' consensus; items they disagree on are left out and counted.
 */
export function calibrationReport(
  items: LabelledItem[],
  { targetPrecision = 0.95, minLabels = 1, bins = [] as number[] } = {},
) {
  if (!(targetPrecision > 0 && targetPrecision <= 1))
    throw new Error('target precision must be in (0, 1]');
  const labelled = items.filter((item) => item.labels.length >= minLabels);
  const multi = labelled.filter((item) => item.labels.length >= 2);
  const agrees = (item: LabelledItem) =>
    new Set(item.labels.map((label) => (label === null ? null : normalizePlate(label)))).size === 1;
  const truth = labelled.filter(agrees).map((item) => ({
    ...item,
    truth: item.labels[0] === null ? null : normalizePlate(item.labels[0]),
    text: item.machine_text ? normalizePlate(item.machine_text) : null,
  }));
  const correct = (row: (typeof truth)[number]) => row.truth !== null && row.text === row.truth;
  const thresholds = thresholdGrid().map((threshold) => {
    const readable = truth.filter(
      (row) => row.text && row.confidence !== null && row.confidence >= threshold,
    );
    const right = readable.filter(correct).length;
    return {
      threshold,
      readable: readable.length,
      correct: right,
      precision: readable.length ? right / readable.length : null,
      coverage: truth.length ? readable.length / truth.length : 0,
    };
  });
  const reaching = thresholds.filter(
    (row) => row.precision !== null && row.precision >= targetPrecision,
  );
  return {
    items: items.length,
    labelled: labelled.length,
    samples: truth.length,
    disagreements: labelled.length - truth.length,
    multi_labelled: multi.length,
    agreement: multi.length ? multi.filter(agrees).length / multi.length : null,
    unreadable_by_labeller: truth.filter((row) => row.truth === null).length,
    exact_match: truth.length ? truth.filter(correct).length / truth.length : null,
    target_precision: targetPrecision,
    recommended_threshold: reaching.length
      ? Math.min(...reaching.map((row) => row.threshold))
      : null,
    thresholds,
    // Accuracy per sampling bin shows where the model's confidence can be trusted.
    bins: bins.slice(1).map((upper, bin) => {
      const rows = truth.filter((row) => row.bin === bin);
      return {
        bin,
        from: bins[bin],
        to: Math.min(upper, 1),
        samples: rows.length,
        exact_match: rows.length ? rows.filter(correct).length / rows.length : null,
      };
    }),
  };
}

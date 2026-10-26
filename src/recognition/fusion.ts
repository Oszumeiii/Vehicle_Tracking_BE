export function normalizePlate(value: string | null | undefined): string {
  return (value ?? '').replace(/[\s-]+/gu, '').toUpperCase();
}

export function fusePredictions(texts: (string | null)[]) {
  if (texts.length !== 1 && texts.length !== 5)
    throw new Error('Expected one image or exactly five crops');
  const counts = new Map<string, number>();
  for (const text of texts) {
    const normalized = normalizePlate(text);
    if (normalized) counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  const winner = [...counts].sort((a, b) => b[1] - a[1])[0];
  if (!winner) return { machine_text: null, machine_status: 'unreadable', agreement_count: 0 };
  const readable = texts.length === 1 || winner[1] >= 3;
  return {
    machine_text: readable ? winner[0] : null,
    machine_status: readable ? 'readable' : 'ambiguous',
    agreement_count: winner[1],
  };
}

/** Edit distance between two normalized plates (insertions, deletions, substitutions). */
export function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current.push(
        Math.min(
          previous[j] + 1,
          current[j - 1] + 1,
          previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        ),
      );
    previous = current;
  }
  return previous[b.length];
}

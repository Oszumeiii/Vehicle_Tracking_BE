/**
 * Failed sign-ins per key within a sliding window (in memory, per API process).
 * After `max` failures the key is refused until the oldest failure leaves the window,
 * even with the right password, so guessing cannot continue by watching for a 200.
 */
export class LoginThrottle {
  private failures = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now = () => Date.now(),
  ) {}

  /** Seconds until the key may try again, or 0 when it may try now. */
  retryAfter(key: string): number {
    const times = this.recent(key);
    if (times.length < this.max) return 0;
    return Math.max(1, Math.ceil((times[0] + this.windowMs - this.now()) / 1000));
  }

  fail(key: string) {
    const times = this.recent(key);
    times.push(this.now());
    this.failures.set(key, times);
    if (this.failures.size > 10000) this.prune();
  }

  succeed(key: string) {
    this.failures.delete(key);
  }

  private recent(key: string) {
    const since = this.now() - this.windowMs;
    return (this.failures.get(key) ?? []).filter((time) => time > since);
  }

  private prune() {
    for (const key of [...this.failures.keys()]) {
      const times = this.recent(key);
      if (times.length) this.failures.set(key, times);
      else this.failures.delete(key);
    }
  }
}

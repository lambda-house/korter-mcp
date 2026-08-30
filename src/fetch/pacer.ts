/**
 * Global request pacer + circuit breaker. Every outbound korter request —
 * tools, sweeps, smoke script — goes through one instance of this. There is no
 * second lane.
 *
 * The breaker is terminal by design (CLAUDE.md hard rule 1): a 403/429 trips
 * it, and nothing in-process resets it. Restarting the process is the only
 * reset, and that is a human decision.
 */
import { RATE_LIMIT_MS } from "../config.js";

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class BreakerOpenError extends Error {
  constructor(readonly reason: string, readonly trippedAt: string) {
    super(
      `korter circuit breaker is open (${reason} at ${trippedAt}). ` +
        `korter.ge is blocking or rate-limiting; by design this tool stops instead of evading. Try again much later.`,
    );
    this.name = "BreakerOpenError";
  }
}

export interface Pacer {
  /** Resolves when the caller may start its request; ≥ interval between starts. */
  acquire(): Promise<void>;
  /** Open the breaker permanently (for this process). */
  trip(reason: string): void;
  isOpen(): boolean;
  tripReason(): string | null;
}

export function createPacer(intervalMs: number = RATE_LIMIT_MS, clock: Clock = systemClock): Pacer {
  let nextFreeAt = 0;
  let tripped: { reason: string; at: string } | null = null;

  return {
    async acquire(): Promise<void> {
      if (tripped) throw new BreakerOpenError(tripped.reason, tripped.at);
      const now = clock.now();
      const startAt = Math.max(now, nextFreeAt);
      nextFreeAt = startAt + intervalMs;
      if (startAt > now) await clock.sleep(startAt - now);
      // Re-check after the wait: a request ahead of us may have tripped it.
      if (tripped) {
        const t: { reason: string; at: string } = tripped;
        throw new BreakerOpenError(t.reason, t.at);
      }
    },
    trip(reason: string): void {
      tripped ??= { reason, at: new Date(clock.now()).toISOString() };
    },
    isOpen: () => tripped !== null,
    tripReason: () => tripped?.reason ?? null,
  };
}

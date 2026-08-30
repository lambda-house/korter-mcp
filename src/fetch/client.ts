/**
 * The one place that talks HTTP to korter.ge. Honest UA, paced, classified.
 *
 * Classification is the contract the Source aggregate builds on:
 *  - ok         → body + hash + fetchedAt
 *  - blocked    → 403/429. Terminal: trips the breaker, no retry, ever.
 *  - gone       → 404/410. The page stopped existing — a delisting signal.
 *  - transient  → 5xx / timeout / network, after FETCH_MAX_RETRIES attempts.
 */
import { createHash } from "node:crypto";
import { FETCH_MAX_RETRIES, FETCH_TIMEOUT_MS, KORTER_ORIGIN, USER_AGENT } from "../config.js";
import { type Clock, type Pacer, systemClock } from "./pacer.js";

export type FetchOutcome =
  | { kind: "ok"; body: string; hash: string; fetchedAt: string; status: number }
  | { kind: "blocked"; status: number; at: string }
  | { kind: "gone"; status: number; at: string }
  | { kind: "transient"; detail: string; attempts: number; at: string };

export interface KorterClient {
  fetchPath(path: string): Promise<FetchOutcome>;
}

export type HttpFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export function createKorterClient(
  pacer: Pacer,
  opts: { origin?: string; clock?: Clock; httpFetch?: HttpFetch; timeoutMs?: number; maxRetries?: number } = {},
): KorterClient {
  const origin = opts.origin ?? KORTER_ORIGIN;
  const clock = opts.clock ?? systemClock;
  const httpFetch: HttpFetch = opts.httpFetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? FETCH_MAX_RETRIES;

  return {
    async fetchPath(path: string): Promise<FetchOutcome> {
      let lastDetail = "";
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) await clock.sleep(backoffMs(attempt));
        await pacer.acquire(); // throws BreakerOpenError once tripped

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await httpFetch(`${origin}${path}`, {
            headers: { "user-agent": USER_AGENT, accept: "text/html" },
            signal: controller.signal,
          });
          const at = new Date(clock.now()).toISOString();
          if (res.status === 403 || res.status === 429) {
            pacer.trip(`HTTP ${res.status} on ${path}`);
            return { kind: "blocked", status: res.status, at };
          }
          if (res.status === 404 || res.status === 410) {
            return { kind: "gone", status: res.status, at };
          }
          if (res.status >= 500) {
            lastDetail = `HTTP ${res.status}`;
            continue;
          }
          if (res.status >= 400) {
            // Unexpected 4xx: not a block, not transient. Fail without retry.
            return { kind: "transient", detail: `HTTP ${res.status}`, attempts: attempt + 1, at };
          }
          const body = await res.text();
          return { kind: "ok", body, hash: sha256(body), fetchedAt: at, status: res.status };
        } catch (e) {
          lastDetail = e instanceof Error ? (e.name === "AbortError" ? `timeout after ${timeoutMs}ms` : e.message) : String(e);
        } finally {
          clearTimeout(timer);
        }
      }
      return {
        kind: "transient",
        detail: lastDetail,
        attempts: maxRetries + 1,
        at: new Date(clock.now()).toISOString(),
      };
    },
  };
}

export function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function backoffMs(attempt: number): number {
  return 500 * 2 ** (attempt - 1); // 500, 1000, 2000
}

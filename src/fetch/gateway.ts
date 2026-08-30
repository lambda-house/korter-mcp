/**
 * The Source aggregate's window on the network: robots-checked, cache-first,
 * paced, classified. Everything korter-shaped funnels through here — there is
 * no other code path that touches korter.ge.
 */
import { type Either, left, right } from "@lambda-house/teob-ts/core";
import { KORTER_ORIGIN } from "../config.js";
import { type FetchFailure, type FetchSuccess, parseSourceId } from "../domain/types.js";
import type { PageCache } from "./cache.js";
import type { KorterClient } from "./client.js";
import { BreakerOpenError } from "./pacer.js";
import { isAllowed, parseRobots, type RobotsRules } from "./robots.js";

export interface FetchGateway {
  fetchSource(sourceId: string, force: boolean): Promise<Either<FetchFailure, FetchSuccess>>;
  sourceUrl(sourceId: string): string;
}

export function createFetchGateway(opts: {
  client: KorterClient;
  cache: PageCache;
  origin?: string;
  now?: () => number;
}): FetchGateway {
  const origin = opts.origin ?? KORTER_ORIGIN;
  const now = opts.now ?? (() => Date.now());
  const nowIso = (): string => new Date(now()).toISOString();
  let robots: RobotsRules | null = null;

  const fail = (kind: FetchFailure["kind"], detail: string): Either<FetchFailure, FetchSuccess> =>
    left({ kind, detail, at: nowIso() });

  /** robots.txt, through the same cache and pacer as everything else. */
  async function loadRobots(): Promise<RobotsRules | FetchFailure> {
    if (robots) return robots;
    const url = `${origin}/robots.txt`;
    const cached = opts.cache.get(url, now());
    if (cached) {
      robots = parseRobots(cached.body);
      return robots;
    }
    const outcome = await opts.client.fetchPath("/robots.txt");
    if (outcome.kind === "ok") {
      opts.cache.put({ url, body: outcome.body, hash: outcome.hash, fetchedAt: outcome.fetchedAt });
      robots = parseRobots(outcome.body);
      return robots;
    }
    if (outcome.kind === "gone") {
      // No robots.txt at all → nothing is disallowed.
      robots = parseRobots("");
      return robots;
    }
    // Blocked or transient: fail closed — we do not fetch what we cannot check.
    const kind = outcome.kind === "blocked" ? (outcome.status === 429 ? "ratelimited" : "blocked") : "transient";
    return { kind, detail: `robots.txt fetch failed (${describe(outcome)})`, at: nowIso() };
  }

  return {
    sourceUrl(sourceId: string): string {
      const parsed = parseSourceId(sourceId);
      return parsed ? `${origin}${parsed.path}` : origin;
    },

    async fetchSource(sourceId, force): Promise<Either<FetchFailure, FetchSuccess>> {
      const parsed = parseSourceId(sourceId);
      if (!parsed) return fail("transient", `malformed source id "${sourceId}"`);
      const url = `${origin}${parsed.path}`;

      if (!force) {
        const cached = opts.cache.get(url, now());
        if (cached) {
          return right({ body: cached.body, hash: cached.hash, fetchedAt: cached.fetchedAt, fromCache: true });
        }
      }

      try {
        const rules = await loadRobots();
        if ("kind" in rules) return left(rules);
        if (!isAllowed(rules, parsed.path)) {
          return fail("robots", `robots.txt disallows ${parsed.path} — stopping, per the rules this tool runs on`);
        }

        const outcome = await opts.client.fetchPath(parsed.path);
        switch (outcome.kind) {
          case "ok":
            opts.cache.put({ url, body: outcome.body, hash: outcome.hash, fetchedAt: outcome.fetchedAt });
            return right({ body: outcome.body, hash: outcome.hash, fetchedAt: outcome.fetchedAt, fromCache: false });
          case "blocked":
            return fail(outcome.status === 429 ? "ratelimited" : "blocked", `HTTP ${outcome.status}`);
          case "gone":
            return fail("gone", `HTTP ${outcome.status}`);
          case "transient":
            return fail("transient", `${outcome.detail} after ${outcome.attempts} attempts`);
        }
      } catch (e) {
        if (e instanceof BreakerOpenError) return fail("breaker", e.message);
        return fail("transient", e instanceof Error ? e.message : String(e));
      }
    },
  };
}

function describe(outcome: { kind: string; status?: number; detail?: string }): string {
  return outcome.detail ?? `${outcome.kind}${outcome.status !== undefined ? ` ${outcome.status}` : ""}`;
}

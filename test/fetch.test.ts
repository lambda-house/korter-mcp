import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createSqlitePageCache } from "../src/fetch/cache.js";
import { createKorterClient, type HttpFetch, sha256 } from "../src/fetch/client.js";
import { BreakerOpenError, type Clock, createPacer } from "../src/fetch/pacer.js";
import { isAllowed, parseRobots } from "../src/fetch/robots.js";
import { hasRealFixtures } from "./helpers.js";

/** Virtual clock: sleep() advances time instantly. */
function virtualClock(): Clock & { t: () => number } {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
    t: () => t,
  };
}

describe("pacer", () => {
  it("keeps ≥1000ms between request starts, across concurrent callers", async () => {
    // A caller's start moment on the virtual timeline is the wake time of the
    // sleep the pacer schedules for it (or now, for the unblocked first one).
    let t = 0;
    const starts: number[] = [];
    const clock: Clock = {
      now: () => t,
      sleep: (ms: number) => {
        starts.push(t + ms);
        t += ms;
        return Promise.resolve();
      },
    };
    const pacer = createPacer(1000, clock);
    await Promise.all(Array.from({ length: 5 }, () => pacer.acquire()));
    // One caller starts immediately at t=0 (no sleep scheduled); the other
    // four are scheduled exactly one interval apart on the virtual timeline.
    expect(starts).toEqual([1000, 2000, 3000, 4000]);
  });

  it("does not delay a caller arriving after the interval has passed", async () => {
    const clock = virtualClock();
    const pacer = createPacer(1000, clock);
    await pacer.acquire();
    await clock.sleep(5000); // idle gap
    const before = clock.t();
    await pacer.acquire();
    expect(clock.t()).toBe(before); // no sleep scheduled
  });

  it("trip() is terminal: every later acquire throws", async () => {
    const pacer = createPacer(1000, virtualClock());
    await pacer.acquire();
    pacer.trip("HTTP 403 on /en/x");
    await expect(pacer.acquire()).rejects.toBeInstanceOf(BreakerOpenError);
    await expect(pacer.acquire()).rejects.toThrow(/stops instead of evading/);
    expect(pacer.isOpen()).toBe(true);
  });
});

describe("robots", () => {
  const live = () =>
    parseRobots(readFileSync(join(import.meta.dirname, "..", "fixtures", "robots.txt"), "utf8"));

  it.skipIf(!hasRealFixtures)("allows the paths this tool uses (verified against the saved live file)", () => {
    for (const p of [
      "/en/new-projects-in-avlabari",
      "/en/tsavkisi-park-tbilisi",
      "/en/new-projects-tbilisi-vake-district",
      "/en/new-projects-in-tbilisi",
    ]) {
      expect(isAllowed(live(), p), p).toBe(true);
    }
  });

  it.skipIf(!hasRealFixtures)("blocks the paths korter disallows — including their own hydration API", () => {
    const rules = live();
    for (const p of ["/api/anything", "/building/geo", "/pyapi/x", "/node-api/x", "/redirect"]) {
      expect(isAllowed(rules, p), p).toBe(false);
    }
    expect(isAllowed(rules, "/en/foo?construction-photo-id=1")).toBe(false);
    expect(isAllowed(rules, "/en/foo/amp/")).toBe(false);
  });

  it("longest-match precedence with Allow", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /a\nAllow: /a/b\n");
    expect(isAllowed(rules, "/a/x")).toBe(false);
    expect(isAllowed(rules, "/a/b/c")).toBe(true);
  });
});

const okResponse = (body: string) => ({ status: 200, text: () => Promise.resolve(body) });

describe("client", () => {
  function testClient(responses: (() => { status: number; text(): Promise<string> })[]) {
    const clock = virtualClock();
    const pacer = createPacer(1000, clock);
    const calls: string[] = [];
    const httpFetch: HttpFetch = (url) => {
      calls.push(url);
      const next = responses.shift();
      if (!next) throw new Error("unexpected extra request");
      return Promise.resolve(next());
    };
    return { client: createKorterClient(pacer, { clock, httpFetch }), pacer, calls };
  }

  it("200 → ok with hash and fetchedAt", async () => {
    const { client } = testClient([() => okResponse("<html>hi</html>")]);
    const out = await client.fetchPath("/en/x");
    expect(out).toMatchObject({ kind: "ok", hash: sha256("<html>hi</html>") });
  });

  it("403 → blocked, breaker trips, no retry", async () => {
    const { client, pacer, calls } = testClient([() => ({ status: 403, text: () => Promise.resolve("") })]);
    const out = await client.fetchPath("/en/x");
    expect(out.kind).toBe("blocked");
    expect(calls).toHaveLength(1); // exactly one request — nothing retries a block
    expect(pacer.isOpen()).toBe(true);
    await expect(client.fetchPath("/en/y")).rejects.toBeInstanceOf(BreakerOpenError);
  });

  it("429 → blocked and terminal, same as 403", async () => {
    const { client, pacer } = testClient([() => ({ status: 429, text: () => Promise.resolve("") })]);
    expect((await client.fetchPath("/en/x")).kind).toBe("blocked");
    expect(pacer.isOpen()).toBe(true);
  });

  it("404 → gone, no retry", async () => {
    const { client, calls } = testClient([() => ({ status: 404, text: () => Promise.resolve("") })]);
    expect((await client.fetchPath("/en/x")).kind).toBe("gone");
    expect(calls).toHaveLength(1);
  });

  it("5xx retries with backoff then succeeds", async () => {
    const { client, calls } = testClient([
      () => ({ status: 502, text: () => Promise.resolve("") }),
      () => ({ status: 502, text: () => Promise.resolve("") }),
      () => okResponse("ok"),
    ]);
    const out = await client.fetchPath("/en/x");
    expect(out.kind).toBe("ok");
    expect(calls).toHaveLength(3);
  });

  it("5xx exhausts retries → transient", async () => {
    const { client, calls } = testClient(
      Array.from({ length: 4 }, () => () => ({ status: 500, text: () => Promise.resolve("") })),
    );
    const out = await client.fetchPath("/en/x");
    expect(out).toMatchObject({ kind: "transient", attempts: 4 });
    expect(calls).toHaveLength(4);
  });
});

describe("page cache", () => {
  it("stores, serves fresh, expires at TTL", () => {
    const cache = createSqlitePageCache(new Database(":memory:"), 24 * 3600 * 1000);
    const t0 = Date.parse("2026-08-30T12:00:00Z");
    cache.put({ url: "/en/x", body: "b", hash: "h", fetchedAt: new Date(t0).toISOString() });
    expect(cache.get("/en/x", t0 + 1000)?.hash).toBe("h");
    expect(cache.get("/en/x", t0 + 23 * 3600 * 1000)?.hash).toBe("h");
    expect(cache.get("/en/x", t0 + 25 * 3600 * 1000)).toBeNull();
    expect(cache.get("/en/unknown", t0)).toBeNull();
  });

  it("purgeExpired removes only stale rows", () => {
    const cache = createSqlitePageCache(new Database(":memory:"), 1000);
    const t0 = Date.parse("2026-08-30T12:00:00Z");
    cache.put({ url: "/a", body: "b", hash: "h", fetchedAt: new Date(t0).toISOString() });
    cache.put({ url: "/b", body: "b", hash: "h", fetchedAt: new Date(t0 + 5000).toISOString() });
    expect(cache.purgeExpired(t0 + 5500)).toBe(1);
    expect(cache.get("/b", t0 + 5500)).not.toBeNull();
  });
});

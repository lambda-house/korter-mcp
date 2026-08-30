/**
 * End-to-end over the real wiring — journal, aggregates, projections, tools —
 * with only the network faked (synthetic korter-shaped pages, see
 * test/synthetic.ts). Covers the PLAN §7 integration contract: refresh →
 * search/get, history accrual with dedup, restart (timer re-arms, no duplicate
 * events), projection rebuild equality, and Source-category retention that
 * never touches Project events.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntityId } from "@lambda-house/teob-ts/core";
import { afterAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { sourceCategory, TRACKER_ID, trackerCategory } from "../src/domain/types.js";
import type { HttpFetch } from "../src/fetch/client.js";
import { createKorterService, type KorterService } from "../src/runtime.js";
import { CATALOG_PROJECTION_ID, type CatalogCard } from "../src/views/catalog.js";
import {
  PARKSIDE_PROJECT,
  SYNTHETIC_ROBOTS,
  syntheticListingPage,
  syntheticProjectPage,
  TESTBURG_LISTING,
} from "./synthetic.js";

const dir = mkdtempSync(join(tmpdir(), "korter-test-"));
const dbPath = join(dir, "korter.db");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const config: Config = {
  mode: "sweep",
  dbPath,
  korterMode: "local",
  sweepIntervalMs: 7 * 24 * 3600 * 1000,
  httpPort: 0,
  adminEmails: [],
};

const LISTING_PATH = "/en/new-projects-in-riverside";
const PROJECT_PATH = "/en/parkside-grove-testburg";
const PROJECT_SOURCE = "project:parkside-grove-testburg";

// Mutable fake korter: tests swap page specs to simulate price changes.
const pages = new Map<string, string>([
  ["/robots.txt", SYNTHETIC_ROBOTS],
  [LISTING_PATH, syntheticListingPage(TESTBURG_LISTING)],
  [PROJECT_PATH, syntheticProjectPage(PARKSIDE_PROJECT)],
]);
const httpFetch: HttpFetch = (url) => {
  const path = new URL(url).pathname;
  const body = pages.get(path);
  return Promise.resolve(
    body === undefined
      ? { status: 404, text: () => Promise.resolve("") }
      : { status: 200, text: () => Promise.resolve(body) },
  );
};

const log = (): void => {};
const openService = (sweepIntervalMs?: number): KorterService =>
  createKorterService(config, log, { httpFetch, pacerIntervalMs: 1, ...(sweepIntervalMs ? { sweepIntervalMs } : {}) });

async function refresh(svc: KorterService, sourceId: string, force = false): Promise<string> {
  const asked = await svc.runtime.ask(sourceId as EntityId, { tag: "Refresh", force }, sourceCategory);
  if (!asked.ok) throw new Error(`ask failed: ${JSON.stringify(asked.error)}`);
  const reply = asked.value.reply;
  if (reply?.tag !== "Done") throw new Error("no outcome");
  svc.runner.runOnce();
  return reply.outcome.tag;
}

const call = async (svc: KorterService, name: string, args: unknown = {}): Promise<Record<string, any>> => {
  const result = await svc.registry.execute({ name, arguments: args });
  if (!result.success) throw new Error(`tool ${name} failed: ${result.error}`);
  return result.output as Record<string, any>;
};

describe("end-to-end over synthetic pages", () => {
  it("refresh → search → get → history → diff → restart → rebuild → retention", async () => {
    const t0 = Date.now();
    let svc = openService();
    try {
      // --- listing refresh populates the catalog ---
      expect(await refresh(svc, "listing:new-projects-in-riverside")).toBe("Fetched");
      const search = await call(svc, "search_projects", {});
      expect(search["count"]).toBe(11);
      const card = (search["projects"] as Record<string, unknown>[]).find(
        (p) => p["slug"] === "river-towers-testburg",
      );
      expect(card).toMatchObject({
        name: "River Towers",
        district: "Riverside",
        price_per_m2: 2800,
        currency: "USD",
        prices_as_of: null,
      });
      expect(typeof card?.["fetched_at"]).toBe("string");
      expect(card?.["staleness_days"]).toBe(0);

      // district filter uses the source's taxonomy as-is
      const riverside = await call(svc, "search_projects", { district: "Riverside" });
      expect(riverside["count"]).toBeGreaterThan(0);

      // districts table came from the listing's embedded taxonomy
      const districts = await call(svc, "list_districts");
      expect((districts["districts"] as unknown[]).length).toBeGreaterThan(10);

      // --- project page refresh: full card + the site's own prices_as_of ---
      expect(await refresh(svc, PROJECT_SOURCE)).toBe("Fetched");
      const parkside = await call(svc, "get_project", { slug: "parkside-grove-testburg" });
      expect(parkside["prices"]).toMatchObject({
        USD: { price_per_m2: 1300, prices_as_of: "2026-07-22T04:12:53+00:00" },
      });
      expect(parkside["staleness_days"] as number).toBeGreaterThan(30);

      // --- unchanged refresh journals nothing new for the project ---
      expect(await refresh(svc, PROJECT_SOURCE, true)).toBe("Unchanged");
      let history = await call(svc, "price_history", { slug: "parkside-grove-testburg" });
      expect((history["history"] as { kind: string }[]).filter((h) => h.kind === "price")).toHaveLength(1);

      // --- price moves on the site → exactly one new PriceObserved ---
      pages.set(
        PROJECT_PATH,
        syntheticProjectPage({
          ...PARKSIDE_PROJECT,
          minPriceSqm: 1350,
          minPrice: 324000,
          pricesUpdateTime: "2026-08-29T04:00:00+00:00",
        }),
      );
      expect(await refresh(svc, PROJECT_SOURCE, true)).toBe("Fetched");
      history = await call(svc, "price_history", { slug: "parkside-grove-testburg" });
      const priceEvents = (history["history"] as Record<string, unknown>[]).filter((h) => h["kind"] === "price");
      expect(priceEvents).toHaveLength(2);
      expect(priceEvents[1]).toMatchObject({ pricePerM2: 1350, pricesAsOf: "2026-08-29T04:00:00+00:00" });

      const diff = await call(svc, "diff_report", { since: new Date(t0 - 1000).toISOString() });
      const change = (diff["priceChanges"] as Record<string, any>[]).find(
        (c) => c["slug"] === "parkside-grove-testburg" && c["to"]["pricePerM2"] === 1350,
      );
      expect(change?.["from"]).toMatchObject({ pricePerM2: 1300 });

      // --- track for the restart half ---
      await call(svc, "track", { source_id: PROJECT_SOURCE });
      await svc.runtime.ask(TRACKER_ID as EntityId, { tag: "RefreshNow" }, trackerCategory);
      await waitFor(() => sweepCount(svc) >= 1, "first SweepStarted");
      const priceCountBefore = projectEventCount(svc, "PriceObserved");
      const cardsBefore = svc.store
        .list<CatalogCard>(CATALOG_PROJECTION_ID)
        .map((e) => e.view)
        .sort((a, b) => a.slug.localeCompare(b.slug));
      await svc.close();

      // --- restart over the same file: timer re-arms, no duplicate events ---
      svc = openService(250 /* ms — the missed 7-day window fires immediately */);
      // Entities recover lazily, on their first command. Every run mode wakes
      // the Tracker at boot via seedIfEmpty(); without that poke,
      // onRecoveryComplete never runs and the timer never re-arms.
      await svc.seedIfEmpty();
      await waitFor(() => sweepCount(svc) >= 2, "timer re-armed sweep after restart");
      await waitFor(() => fetchLifecycleCount(svc) > 0, "sweep refreshed sources");
      expect(projectEventCount(svc, "PriceObserved")).toBe(priceCountBefore); // dedup across restarts

      // --- rebuild every projection from the journal and compare ---
      svc.runner.runOnce();
      const live = svc.store
        .list<CatalogCard>(CATALOG_PROJECTION_ID)
        .map((e) => e.view)
        .sort((a, b) => a.slug.localeCompare(b.slug));
      expect(live.length).toBeGreaterThanOrEqual(cardsBefore.length);
      svc.runner.rebuild(CATALOG_PROJECTION_ID);
      const rebuilt = svc.store
        .list<CatalogCard>(CATALOG_PROJECTION_ID)
        .map((e) => e.view)
        .sort((a, b) => a.slug.localeCompare(b.slug));
      expect(rebuilt).toEqual(live);

      // --- retention prunes old Source events, never Project events ---
      const backdated = svc.journal.db
        .prepare("UPDATE journal SET timestamp = timestamp - 200*86400 WHERE persistence_id LIKE 'source:%'")
        .run().changes;
      expect(backdated).toBeGreaterThan(0);
      const pruned = svc.pruneSourceJournal();
      expect(pruned).toBe(backdated);
      expect(projectEventCount(svc, "PriceObserved")).toBe(priceCountBefore);
      // sources recover from snapshots (snapshotEvery: 1), so a fetch after
      // pruning still dedups on hash instead of re-emitting Fetched
      expect(await refresh(svc, PROJECT_SOURCE, true)).toBe("Unchanged");
    } finally {
      await svc.close();
    }
  }, 30_000);

  it("404 delists a project via its source", async () => {
    const svc = openService();
    try {
      expect(await refresh(svc, PROJECT_SOURCE)).toBe("Unchanged"); // same db, cached page
      pages.delete(PROJECT_PATH);
      const outcome = await refresh(svc, PROJECT_SOURCE, true);
      expect(outcome).toBe("Failed");
      await waitFor(() => {
        svc.runner.runOnce();
        const cardNow = svc.store.get<CatalogCard>(CATALOG_PROJECTION_ID, "parkside-grove-testburg");
        return cardNow?.view.delisted === true;
      }, "project delisted after 404");
    } finally {
      await svc.close();
    }
  }, 15_000);
});

function sweepCount(svc: KorterService): number {
  return svc.journal.queryEvents({ category: "tracker", order: "asc", limit: 1000 }).filter((r) => r.manifest === "SweepStarted").length;
}

function fetchLifecycleCount(svc: KorterService): number {
  return svc.journal
    .queryEvents({ category: "source", order: "asc", limit: 1000 })
    .filter((r) => r.manifest === "Fetched" || r.manifest === "FetchUnchanged").length;
}

function projectEventCount(svc: KorterService, manifest: string): number {
  return svc.journal.queryEvents({ category: "project", order: "asc", limit: 1000 }).filter((r) => r.manifest === manifest).length;
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

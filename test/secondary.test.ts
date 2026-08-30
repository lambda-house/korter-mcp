/**
 * Secondary market + identity/consent, end to end over synthetic pages:
 * extraction (with the PII-drop guarantee), snapshot search, aggregate-trend
 * journaling with dedup, tier gating, the consent flow, interest tracking,
 * and the operator's user list.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntityId } from "@lambda-house/teob-ts/core";
import { afterAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { sourceCategory } from "../src/domain/types.js";
import type { HttpFetch } from "../src/fetch/client.js";
import { extractPage } from "../src/parse/extract.js";
import { type Identity, runWithIdentity } from "../src/mcp/identity.js";
import { createKorterService, type KorterService } from "../src/runtime.js";
import { fixture, hasRealFixtures } from "./helpers.js";
import { RIVERSIDE_RENT, RIVERSIDE_SALE, SYNTHETIC_ROBOTS, syntheticSecondaryPage } from "./synthetic.js";

const dir = mkdtempSync(join(tmpdir(), "korter-secondary-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const config: Config = {
  mode: "sweep",
  dbPath: join(dir, "korter.db"),
  korterMode: "local",
  sweepIntervalMs: 7 * 24 * 3600 * 1000,
  httpPort: 0,
  adminEmails: ["boss@example.com"],
};

const SALE_PATH = "/en/apartments-sale-testburg-riverside-district";
const pages = new Map<string, string>([
  ["/robots.txt", SYNTHETIC_ROBOTS],
  [SALE_PATH, syntheticSecondaryPage(RIVERSIDE_SALE)],
  ["/en/apartments-for-rent-testburg-riverside", syntheticSecondaryPage(RIVERSIDE_RENT)],
]);
const httpFetch: HttpFetch = (url) => {
  const body = pages.get(new URL(url).pathname);
  return Promise.resolve(
    body === undefined
      ? { status: 404, text: () => Promise.resolve("") }
      : { status: 200, text: () => Promise.resolve(body) },
  );
};

const endUser: Identity = { sub: "google:alice", email: "alice@example.com", name: "Alice", provider: "google", operator: false };
const admin: Identity = { sub: "google:boss", email: "boss@example.com", name: "Boss", provider: "google", operator: true };

async function rawCall(svc: KorterService, name: string, args: unknown = {}) {
  return svc.registry.execute({ name, arguments: args });
}
async function call(svc: KorterService, name: string, args: unknown = {}): Promise<Record<string, any>> {
  const result = await rawCall(svc, name, args);
  if (!result.success) throw new Error(`${name}: ${result.error}`);
  return result.output as Record<string, any>;
}
const asUser = <T>(id: Identity, fn: () => Promise<T>): Promise<T> => runWithIdentity(id, fn);

describe("secondary extraction drops seller identity", () => {
  it("synthetic page: property facts survive, userId does not", () => {
    const page = extractPage(syntheticSecondaryPage(RIVERSIDE_SALE));
    if (page.pageType !== "secondary") throw new Error("expected secondary");
    expect(page.section).toBe("sale");
    expect(page.listings).toHaveLength(4);
    expect(page.listings[0]).toMatchObject({
      objectId: 1,
      district: "Riverside",
      price: 215000,
      areaM2: 78,
      pricePerM2: Math.round(215000 / 78),
      roomCount: 3,
      floor: 20,
      floorCount: 26,
      buildingSlug: "river-towers-testburg",
    });
    expect(page.totalCount).toBe(240);
    expect(page.aggregates.find((a) => a.name === "Riverside")).toMatchObject({ avgPriceSqm: 2100, rentMax: 4000 });
    // The guarantee, not a hope: no seller identifier anywhere in the output.
    expect(JSON.stringify(page)).not.toMatch(/userId|900001/);
  });

  it.skipIf(!hasRealFixtures)("real korter page: same guarantee", () => {
    const page = extractPage(fixture("apartments-sale-tbilisi-vake-district.html"));
    if (page.pageType !== "secondary") throw new Error("expected secondary");
    expect(page.listings.length).toBeGreaterThan(10);
    expect(JSON.stringify(page)).not.toMatch(/userId/);
    expect(page.listings[0]?.actualizeTime).toBeTruthy();
  });

  it.skipIf(!hasRealFixtures)("real rent page parses with monthly prices", () => {
    const page = extractPage(fixture("apartments-for-rent-tbilisi-vake.html"));
    if (page.pageType !== "secondary") throw new Error("expected secondary");
    expect(page.section).toBe("rent");
    expect(page.listings.every((l) => l.section === "rent")).toBe(true);
  });
});

describe("secondary end to end + identity tiers", () => {
  it("refresh → search/trends; consent gate; interests; operator surface", async () => {
    const svc = createKorterService(config, () => {}, { httpFetch, pacerIntervalMs: 1 });
    try {
      // Operator (local context) refreshes both secondary sources.
      for (const id of ["secondary:apartments-sale-testburg-riverside-district", "secondary:apartments-for-rent-testburg-riverside"]) {
        const asked = await svc.runtime.ask(id as EntityId, { tag: "Refresh", force: false }, sourceCategory);
        expect(asked.ok && asked.value.reply?.tag === "Done" && asked.value.reply.outcome.tag === "Fetched").toBe(true);
      }

      // --- snapshot search (local context, ungated) ---
      const two = await call(svc, "search_secondary", { district: "Riverside", rooms: 2, max_price: 130000 });
      expect(two["count"]).toBe(2);
      const cheap = (two["listings"] as Record<string, unknown>[])[0];
      expect(cheap).toMatchObject({ price: 96000, rooms: 2, district: "Riverside" });
      expect(String(cheap?.["korter_url"])).toMatch(/^https:\/\/korter\.ge\/en\//);
      expect(cheap?.["actualize_staleness_days"]).not.toBeNull();

      // sold listings are excluded by default
      const all = await call(svc, "search_secondary", { district: "Riverside" });
      expect(all["count"]).toBe(3);
      const withSold = await call(svc, "search_secondary", { district: "Riverside", include_unavailable: true });
      expect(withSold["count"]).toBe(4);

      // rent section with monthly cap
      const rent = await call(svc, "search_secondary", { section: "rent", max_price: 1500 });
      expect(rent["count"]).toBe(1);

      // no-snapshot filter → actionable hint naming the exact source
      const empty = await call(svc, "search_secondary", { district: "Old Mill" });
      expect(empty["count"]).toBe(0);
      expect(String(empty["hint"])).toContain("secondary:apartments-sale-testburg-old-mill-district");

      // trends: current aggregates + journaled series ("Riverside District"
      // from the page's geoObject must match a user's "Riverside")
      const trends = await call(svc, "secondary_trends", { district: "Riverside" });
      expect((trends["districts"] as unknown[]).length).toBe(1);
      const trend = trends["trend"] as Record<string, unknown>[];
      expect(trend.some((t) => t["district"] === "Riverside District" && t["avgPriceSqm"] === 2100)).toBe(true);
      // our own page-sample median accrues even when korter hides the focus average
      expect(trend.every((t) => typeof t["sample_median_price_per_m2"] === "number")).toBe(true);

      // aggregate dedup: unchanged refresh journals no second SecondaryMarketObserved
      const countBefore = secondaryEventCount(svc);
      await svc.runtime.ask("secondary:apartments-sale-testburg-riverside-district" as EntityId, { tag: "Refresh", force: true }, sourceCategory);
      expect(secondaryEventCount(svc)).toBe(countBefore);
      // market moved → exactly one new aggregate event
      pages.set(SALE_PATH, syntheticSecondaryPage({ ...RIVERSIDE_SALE, aggregates: [{ ...RIVERSIDE_SALE.aggregates![0]!, avg: 2200 }, RIVERSIDE_SALE.aggregates![1]!] }));
      await svc.runtime.ask("secondary:apartments-sale-testburg-riverside-district" as EntityId, { tag: "Refresh", force: true }, sourceCategory);
      expect(secondaryEventCount(svc)).toBe(countBefore + 1);

      // --- identity tiers ---
      // End user, pre-consent: reads blocked with instructions; open tools work.
      const blocked = await asUser(endUser, () => rawCall(svc, "search_secondary", {}));
      expect(blocked.success).toBe(false);
      expect(blocked.error).toMatch(/consent/i);
      const notice = await asUser(endUser, () => call(svc, "get_skill", { name: "privacy" }));
      expect(String(notice)).toMatch(/OPTIONAL and never a condition/);

      // Consent: terms yes, marketing yes.
      const consented = await asUser(endUser, () => call(svc, "consent", { accept_terms: true, marketing_offers: true }));
      expect(consented).toMatchObject({ terms_accepted: true, marketing_offers: true });

      // Reads now work and record the interest.
      const found = await asUser(endUser, () => call(svc, "search_secondary", { district: "Riverside", rooms: 2, max_price: 130000 }));
      expect(found["count"]).toBe(2);
      const mine = await asUser(endUser, () => call(svc, "my_data", {}));
      expect(mine["terms_accepted_version"]).toBeTruthy();
      const log = mine["consent_and_interest_log"] as Record<string, unknown>[];
      expect(log.some((e) => e["tag"] === "ConsentGranted" && e["kind"] === "marketing")).toBe(true);
      expect(log.some((e) => e["tag"] === "InterestObserved" && e["district"] === "Riverside" && e["rooms"] === 2)).toBe(true);

      // Command tools stay operator-only for end users.
      const denied = await asUser(endUser, () => rawCall(svc, "refresh", { source_id: "project:x-y" }));
      expect(denied.success).toBe(false);
      expect(denied.error).toMatch(/[Oo]perator/);
      const noUsers = await asUser(endUser, () => rawCall(svc, "list_users", {}));
      expect(noUsers.success).toBe(false);

      // Admin identity passes everything; list_users shows the opted-in profile.
      const users = await asUser(admin, () => call(svc, "list_users", {}));
      expect(users["count"]).toBe(1);
      const alice = (users["users"] as Record<string, unknown>[])[0]!;
      expect(alice).toMatchObject({ email: "alice@example.com", marketing: true });
      expect((alice["interests"] as unknown[]).length).toBeGreaterThan(0);

      // Revocation is one call and journaled.
      await asUser(endUser, () => call(svc, "consent", { marketing_offers: false }));
      const after = await asUser(admin, () => call(svc, "list_users", {}));
      expect((after["users"] as Record<string, unknown>[])[0]).toMatchObject({ marketing: false });
    } finally {
      await svc.close();
    }
  }, 20_000);
});

function secondaryEventCount(svc: KorterService): number {
  return svc.journal
    .queryEvents({ category: "source", order: "asc", limit: 1000 })
    .filter((r) => r.manifest === "SecondaryMarketObserved").length;
}

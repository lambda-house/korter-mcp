/**
 * The refined search surface against the real end-to-end wiring (synthetic
 * korter-shaped pages as the fake network): card-level criteria, unit-level
 * criteria, the needs_unit_data escalation, and the skills tool.
 */
import type { EntityId } from "@lambda-house/teob-ts/core";
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";
import { sourceCategory } from "../src/domain/types.js";
import type { HttpFetch } from "../src/fetch/client.js";
import { createKorterService, type KorterService } from "../src/runtime.js";
import {
  PARKSIDE_PROJECT,
  SYNTHETIC_ROBOTS,
  syntheticListingPage,
  syntheticProjectPage,
  TESTBURG_LISTING,
} from "./synthetic.js";

const dir = mkdtempSync(join(tmpdir(), "korter-search-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const config: Config = {
  mode: "sweep",
  dbPath: join(dir, "korter.db"),
  korterMode: "local",
  sweepIntervalMs: 7 * 24 * 3600 * 1000,
  httpPort: 0,
  adminEmails: [],
};

const pages = new Map<string, string>([
  ["/robots.txt", SYNTHETIC_ROBOTS],
  ["/en/new-projects-in-riverside", syntheticListingPage(TESTBURG_LISTING)],
  ["/en/parkside-grove-testburg", syntheticProjectPage(PARKSIDE_PROJECT)],
]);
const httpFetch: HttpFetch = (url) => {
  const body = pages.get(new URL(url).pathname);
  return Promise.resolve(
    body === undefined
      ? { status: 404, text: () => Promise.resolve("") }
      : { status: 200, text: () => Promise.resolve(body) },
  );
};

async function call(svc: KorterService, name: string, args: unknown = {}): Promise<Record<string, any>> {
  const result = await svc.registry.execute({ name, arguments: args });
  if (!result.success) throw new Error(`${name}: ${result.error}`);
  return result.output as Record<string, any>;
}

describe("refined search criteria", () => {
  it("card filters, unit filters, needs_unit_data escalation, skills", async () => {
    const svc = createKorterService(config, () => {}, { httpFetch, pacerIntervalMs: 1 });
    try {
      for (const id of ["listing:new-projects-in-riverside", "project:parkside-grove-testburg"]) {
        const asked = await svc.runtime.ask(id as EntityId, { tag: "Refresh", force: false }, sourceCategory);
        if (!asked.ok) throw new Error("refresh failed");
      }
      svc.runner.runOnce();

      // Card-level: budget + status narrow the listing.
      const budget = await call(svc, "search_projects", { district: "Riverside", max_budget: 100000 });
      expect(budget["count"]).toBeGreaterThan(0);
      for (const p of budget["projects"] as Record<string, unknown>[]) {
        expect(p["price_from"] as number).toBeLessThanOrEqual(100000);
      }
      const ready = await call(svc, "search_projects", { district: "Riverside", construction_status: "ready" });
      expect(ready["count"]).toBeGreaterThan(0);
      for (const p of ready["projects"] as Record<string, unknown>[]) {
        expect(p["construction_status"]).toBe("ready");
      }

      // Unit-level criteria: listing cards have no unit data → all escalate.
      const area = await call(svc, "search_projects", { district: "Riverside", min_area_m2: 100, max_area_m2: 120 });
      expect(area["count"]).toBe(0);
      expect((area["needs_unit_data"] as string[]).length).toBeGreaterThan(10);
      expect(area["hint"]).toMatch(/refresh/i);

      // Parkside has a project page observed → unit filters bite.
      const townhouses = await call(svc, "search_projects", { rooms: 2, min_area_m2: 240, max_area_m2: 310 });
      expect((townhouses["projects"] as Record<string, unknown>[]).map((p) => p["slug"])).toContain(
        "parkside-grove-testburg",
      );
      const noMatch = await call(svc, "search_projects", { city: "Greenvale", rooms: 5 });
      expect(noMatch["count"]).toBe(0);
      expect(noMatch["needs_unit_data"]).toBeUndefined(); // page observed — a true miss, not missing data

      // Unit summary on the card.
      const card = (townhouses["projects"] as Record<string, any>[]).find((p) => p["slug"] === "parkside-grove-testburg")!;
      expect(card["unit_data"]).toBe(true);
      expect(card["rooms_available"]).toEqual([1, 2]);
      expect(card["area_range_m2"]).toEqual([240, 302]);
      expect(card["renovation"]).toBe("green frame");

      // get_project exposes the full breakdown.
      const full = await call(svc, "get_project", { slug: "parkside-grove-testburg" });
      expect((full["unit_types"] as unknown[]).length).toBe(2);

      // Skills as tools.
      const skill = await call(svc, "get_skill", { name: "apartment-search" });
      expect(String(skill)).toMatch(/needs_unit_data/);
      const coverage = await call(svc, "get_skill", { name: "criteria-coverage" });
      expect(String(coverage)).toMatch(/persona/i);
      const bad = await svc.registry.execute({ name: "get_skill", arguments: { name: "nope" } });
      expect(bad.success).toBe(false);
    } finally {
      await svc.close();
    }
  }, 20_000);
});

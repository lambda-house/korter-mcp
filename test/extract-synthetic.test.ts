/**
 * Parser coverage on synthetic pages — the public-safe half of the extraction
 * suite. extract.test.ts pins the same logic to real saved korter pages and
 * skips when those (internal-only) fixtures are absent.
 */
import { describe, expect, it } from "vitest";
import { extractPage } from "../src/parse/extract.js";
import { ParseError } from "../src/parse/types.js";
import {
  PARKSIDE_PROJECT,
  SYNTHETIC_ROBOTS,
  syntheticListingPage,
  syntheticProjectPage,
  TESTBURG_LISTING,
} from "./synthetic.js";
import { isAllowed, parseRobots } from "../src/fetch/robots.js";

describe("extractPage on a synthetic listing", () => {
  const page = extractPage(syntheticListingPage(TESTBURG_LISTING));
  if (page.pageType !== "listing") throw new Error("expected listing");

  it("identifies the page, currency and card count", () => {
    expect(page.slug).toBe("new-projects-in-riverside");
    expect(page.currency).toBe("USD");
    expect(page.totalCount).toBe(11);
    expect(page.projects).toHaveLength(11);
  });

  it("extracts a full card", () => {
    const card = page.projects.find((p) => p.slug === "river-towers-testburg");
    expect(card).toMatchObject({
      korterId: 101,
      name: "River Towers",
      address: "Quay 7",
      district: "Riverside",
      city: "Testburg",
      developer: "Acme Build",
      constructionStatus: "construction",
      salesStatus: "available",
      priceFrom: 150000,
      pricePerM2: 2800,
      pricesAsOf: null,
      unitTypes: null,
      isDeleted: false,
    });
  });

  it("extracts the taxonomy tree and average prices", () => {
    expect(page.taxonomy?.name).toBe("Testburg");
    expect(page.taxonomy?.children.map((d) => d.name)).toContain("Old Mill");
    const riverside = page.taxonomy?.children.find((d) => d.name === "Riverside");
    expect(riverside?.children.map((m) => m.name)).toContain("Quayside");
    expect(page.districtAvgPrices.find((d) => d.name === "Riverside")).toMatchObject({ id: 10, averagePrice: 1381 });
  });
});

describe("extractPage on a synthetic project page", () => {
  const page = extractPage(syntheticProjectPage(PARKSIDE_PROJECT));
  if (page.pageType !== "project") throw new Error("expected project");
  const p = page.projects[0]!;

  it("extracts the full observation including units and renovation", () => {
    expect(p).toMatchObject({
      slug: "parkside-grove-testburg",
      korterId: 300,
      name: "Parkside Grove",
      address: null,
      district: "Hillcrest",
      city: "Greenvale",
      developer: "Acme Build",
      buildingType: "cottage",
      renovation: "green frame",
      priceFrom: 312000,
      pricePerM2: 1300,
      pricesAsOf: "2026-07-22T04:12:53+00:00",
    });
    expect(p.unitTypes).toHaveLength(2);
    expect(p.unitTypes?.[1]).toMatchObject({ roomCount: 2, areaMin: 240, areaMax: 302, priceMin: 312000 });
  });
});

describe("degraded synthetic pages", () => {
  it("GEL variant", () => {
    expect(extractPage(syntheticProjectPage({ ...PARKSIDE_PROJECT, currency: "GEL" })).currency).toBe("GEL");
  });

  it("zero prices mean no price", () => {
    const page = extractPage(syntheticProjectPage({ ...PARKSIDE_PROJECT, minPrice: 0, minPriceSqm: 0 }));
    expect(page.projects[0]).toMatchObject({ priceFrom: null, pricePerM2: null });
  });

  it("missing pricesUpdateTime → null", () => {
    const page = extractPage(syntheticProjectPage({ ...PARKSIDE_PROJECT, pricesUpdateTime: null }));
    expect(page.projects[0]?.pricesAsOf).toBeNull();
  });

  it("no INITIAL_STATE → ParseError", () => {
    expect(() => extractPage("<html>maintenance</html>")).toThrow(/INITIAL_STATE not found/);
  });

  it("truncated state → ParseError", () => {
    const html = syntheticProjectPage(PARKSIDE_PROJECT);
    expect(() => extractPage(html.slice(0, html.indexOf("INITIAL_STATE") + 300))).toThrow(ParseError);
  });
});

describe("synthetic robots", () => {
  it("permits pages, blocks the api", () => {
    const rules = parseRobots(SYNTHETIC_ROBOTS);
    expect(isAllowed(rules, "/en/river-towers-testburg")).toBe(true);
    expect(isAllowed(rules, "/api/x")).toBe(false);
  });
});

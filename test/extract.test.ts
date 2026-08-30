/**
 * Parser compatibility with korter's REAL pages. The fixtures are korter's
 * content and live only in the internal repo — this whole file skips when
 * they are absent (the public snapshot). Logic coverage that does not need
 * korter's bytes lives in extract-synthetic.test.ts and runs everywhere.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractPage } from "../src/parse/extract.js";
import { ParseError } from "../src/parse/types.js";
import { hasRealFixtures } from "./helpers.js";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, "..", "fixtures", name), "utf8");

if (!hasRealFixtures) {
  describe("extractPage on real korter fixtures", () => {
    it.todo("skipped — internal-only fixtures absent; see extract-synthetic.test.ts");
  });
} else {
  realFixtureSuite();
}

function realFixtureSuite(): void {
const avlabari = fixture("new-projects-in-avlabari.html");
const tsavkisi = fixture("tsavkisi-park-tbilisi.html");
const vake = fixture("new-projects-tbilisi-vake-district.html");

describe("extractPage on a listing page", () => {
  const page = extractPage(avlabari);
  if (page.pageType !== "listing") throw new Error("expected listing");

  it("identifies the page and currency", () => {
    expect(page.slug).toBe("new-projects-in-avlabari");
    expect(page.currency).toBe("USD");
    expect(page.totalCount).toBe(11);
    expect(page.projects).toHaveLength(11);
  });

  it("extracts a full card", () => {
    const card = page.projects.find((p) => p.slug === "10-vakhtang-vi-street-tbilisi");
    expect(card).toMatchObject({
      korterId: 3251,
      name: "Avlabari Residence",
      address: "Vakhtang VI St, 10",
      district: "Isani",
      city: "Tbilisi",
      developer: "Nexus Group",
      constructionStatus: "construction",
      salesStatus: "available",
      priceFrom: 150080,
      pricePerM2: 2800,
      pricesAsOf: null, // listing cards never carry a prices date
      isDeleted: false,
    });
    expect(card?.lat).toBeCloseTo(41.69546838);
    expect(card?.lng).toBeCloseTo(44.81331015);
  });

  it("extracts korter's district taxonomy as-is", () => {
    const districts = extractPage(vake);
    if (districts.pageType !== "listing") throw new Error("expected listing");
    expect(districts.taxonomy?.name).toBe("Tbilisi");
    expect(districts.taxonomy?.category).toBe("city");
    const names = districts.taxonomy?.children.map((d) => d.name);
    expect(names).toContain("Chugureti");
    expect(names).toContain("Gldani");
    const didube = districts.taxonomy?.children.find((d) => d.name === "Didube");
    expect(didube?.link).toBe("/en/new-projects-tbilisi-didube-district");
    expect(didube?.children.map((m) => m.name)).toContain("Dighomi Massive");
  });

  it("extracts district average prices", () => {
    const isani = page.districtAvgPrices.find((d) => d.name === "Isani");
    expect(isani).toMatchObject({ id: 23, averagePrice: 1381 });
    expect(isani?.link).toBe("/en/new-projects-tbilisi-isani-district");
  });
});

describe("extractPage on a project page", () => {
  const page = extractPage(tsavkisi);
  if (page.pageType !== "project") throw new Error("expected project");
  const p = page.projects[0]!;

  it("extracts the full observation", () => {
    expect(page.slug).toBe("tsavkisi-park-tbilisi");
    expect(page.currency).toBe("USD");
    expect(page.projects).toHaveLength(1);
    expect(p).toMatchObject({
      slug: "tsavkisi-park-tbilisi",
      korterId: 3466,
      name: "Tsavkisi Park",
      address: null, // genuinely absent on this page — stays null
      district: "Mtatsminda",
      city: "Tsavkisi",
      developer: "Zevs",
      constructionStatus: "construction",
      salesStatus: "available",
      buildingType: "cottage",
      priceFrom: 312000,
      pricePerM2: 1300,
      isDeleted: false,
    });
    expect(p.lat).toBeCloseTo(41.67636154);
    expect(p.lng).toBeCloseTo(44.75383455);
  });

  it("carries korter's own prices-as-of date, not ours", () => {
    expect(p.pricesAsOf).toBe("2026-07-22T04:12:53+00:00");
  });
});

describe("degraded pages", () => {
  it("GEL currency variant", () => {
    const gel = tsavkisi.replace('"currency":"USD"', '"currency":"GEL"');
    expect(extractPage(gel).currency).toBe("GEL");
  });

  it("unknown currency is a parse error, not a guess", () => {
    const eur = tsavkisi.replace('"currency":"USD"', '"currency":"EUR"');
    expect(() => extractPage(eur)).toThrow(ParseError);
  });

  it("zero price means no price", () => {
    const noPrices = tsavkisi
      .replaceAll('"minPrice":312000', '"minPrice":0')
      .replaceAll('"minPriceSqm":1300', '"minPriceSqm":0');
    const page = extractPage(noPrices);
    expect(page.projects[0]).toMatchObject({ priceFrom: null, pricePerM2: null });
  });

  it("missing pricesUpdateTime → pricesAsOf null", () => {
    const undated = tsavkisi.replace(/"pricesUpdateTime":"[^"]+"/, '"pricesUpdateTime":null');
    expect(extractPage(undated).projects[0]?.pricesAsOf).toBeNull();
  });

  it("page without INITIAL_STATE", () => {
    expect(() => extractPage("<html><body>maintenance</body></html>")).toThrow(
      /INITIAL_STATE not found/,
    );
  });

  it("truncated INITIAL_STATE", () => {
    const cut = tsavkisi.slice(0, tsavkisi.indexOf("window.INITIAL_STATE") + 5000);
    expect(() => extractPage(cut)).toThrow(ParseError);
  });

  it("state present but neither store", () => {
    const html = 'x<script>window.INITIAL_STATE = {"seoStore":{"originalUrl":"/en/x"},"currencyStore":{"currency":"USD"}};</script>';
    expect(() => extractPage(html)).toThrow(/no buildingListingStore\/buildingLandingStore\/apartmentListingStore/);
  });
});
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectCommand } from "../src/domain/types.js";
import type { ProjectObservation } from "../src/parse/types.js";

export const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, "..", "fixtures", name), "utf8");

/**
 * Real korter fixtures are korter's content and stay in the internal repo
 * (never in the public snapshot). Tests that pin the parser to korter's actual
 * pages skip when they are absent; everything else runs on test/synthetic.ts.
 */
export const hasRealFixtures = existsSync(join(import.meta.dirname, "..", "fixtures", "tsavkisi-park-tbilisi.html"));

export const obs = (over: Partial<ProjectObservation> = {}): ProjectObservation => ({
  slug: "tsavkisi-park-tbilisi",
  korterId: 3466,
  name: "Tsavkisi Park",
  address: null,
  district: "Mtatsminda",
  city: "Tsavkisi",
  developer: "Zevs",
  lat: 41.67636154,
  lng: 44.75383455,
  constructionStatus: "construction",
  salesStatus: "available",
  buildingType: "cottage",
  priceFrom: 312000,
  pricePerM2: 1300,
  pricesAsOf: "2026-07-22T04:12:53+00:00",
  unitTypes: null, // listing-card shape by default; set explicitly for project-page cases
  renovation: null,
  isDeleted: false,
  ...over,
});

export const observe = (o: ProjectObservation = obs(), at = "2026-08-30T10:00:00Z"): ProjectCommand => ({
  tag: "Observe",
  obs: o,
  currency: "USD",
  sourceUrl: "https://korter.ge/en/tsavkisi-park-tbilisi",
  sourceHash: "hash-1",
  observedAt: at,
});

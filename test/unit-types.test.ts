import { EntityId } from "@lambda-house/teob-ts/core";
import { createAggregateTestKit } from "@lambda-house/teob-ts/testing";
import { describe, expect, it } from "vitest";
import { projectAggregate } from "../src/domain/project.js";
import { extractPage } from "../src/parse/extract.js";
import type { UnitTypeObservation } from "../src/parse/types.js";
import { fixture, hasRealFixtures, obs, observe } from "./helpers.js";

const units: UnitTypeObservation[] = [
  {
    name: "2-room townhouses",
    propertyType: "townhouse",
    roomCount: 2,
    areaMin: 240,
    areaMax: 302,
    priceMin: 312000,
    priceMax: 392600,
    pricePerM2Min: 1300,
    allSold: false,
  },
];

describe.skipIf(!hasRealFixtures)("unit types extraction (real korter fixtures — internal only)", () => {
  it("parses prices.unitTypes from a project page", () => {
    const page = extractPage(fixture("tsavkisi-park-tbilisi.html"));
    const p = page.projects[0]!;
    expect(p.unitTypes).toHaveLength(2);
    expect(p.unitTypes?.[1]).toMatchObject({
      name: "2-room townhouses",
      propertyType: "townhouse",
      roomCount: 2,
      areaMin: 240,
      areaMax: 302,
      priceMin: 312000,
      priceMax: 392600,
      allSold: false,
    });
    expect(p.renovation).toBe("green frame");
  });

  it("listing cards carry unitTypes: null, never []", () => {
    const page = extractPage(fixture("new-projects-in-avlabari.html"));
    expect(page.projects[0]?.unitTypes).toBeNull();
  });
});

describe("UnitTypesObserved dedup", () => {
  const kit = createAggregateTestKit(projectAggregate, EntityId("tsavkisi-park-tbilisi"));

  it("first project-page observation journals the breakdown; identical repeat journals nothing", async () => {
    const first = await kit.runAndApply(kit.initialState, observe(obs({ unitTypes: units })));
    expect(first.result.events.map((e) => e.tag)).toContain("UnitTypesObserved");
    const repeat = await kit.run(first.newState, observe(obs({ unitTypes: units })));
    expect(repeat.result.events).toHaveLength(0);
  });

  it("a changed unit set journals exactly one new event", async () => {
    const first = await kit.runAndApply(kit.initialState, observe(obs({ unitTypes: units })));
    const changed = [{ ...units[0]!, priceMin: 320000 }];
    const next = await kit.run(first.newState, observe(obs({ unitTypes: changed })));
    expect(next.result.events.map((e) => e.tag)).toEqual(["UnitTypesObserved"]);
  });

  it("a listing observation (null) does not clear known unit data", async () => {
    const withUnits = await kit.runAndApply(kit.initialState, observe(obs({ unitTypes: units })));
    const fromListing = await kit.run(withUnits.newState, observe(obs({ unitTypes: null })));
    expect(fromListing.result.events).toHaveLength(0);
    expect(withUnits.newState.unitTypes).toHaveLength(1);
  });

  it("renovation lands in AttributesObserved once", async () => {
    const first = await kit.runAndApply(kit.initialState, observe(obs({ renovation: "green frame" })));
    const attrs = first.result.events.find((e) => e.tag === "AttributesObserved");
    expect(attrs).toMatchObject({ renovation: "green frame" });
    const repeat = await kit.run(first.newState, observe(obs({ renovation: "green frame" })));
    expect(repeat.result.events).toHaveLength(0);
  });
});

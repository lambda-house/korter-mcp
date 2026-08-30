import { CategoryId, EntityId, type EffectControl } from "@lambda-house/teob-ts/core";
import { createAggregateTestKit, createMockControl } from "@lambda-house/teob-ts/testing";
import { describe, expect, it } from "vitest";
import { projectAggregate } from "../src/domain/project.js";
import { createSourceAggregate, type SourceDeps } from "../src/domain/source.js";
import { createTrackerAggregate } from "../src/domain/tracker.js";
import type { ProjectCommand, ProjectState, TrackerCommand } from "../src/domain/types.js";
import type { ProjectObservation } from "../src/parse/types.js";
import { sha256 } from "../src/fetch/client.js";

import { obs, observe } from "./helpers.js";
import { syntheticListingPage, TESTBURG_LISTING } from "./synthetic.js";

describe("Project aggregate — the dedup rule", () => {
  const kit = createAggregateTestKit(projectAggregate, EntityId("tsavkisi-park-tbilisi"));

  it("first observation → Discovered + Attributes + Price", async () => {
    const { result } = await kit.run(kit.initialState, observe());
    expect(result.events.map((e) => e.tag)).toEqual(["ProjectDiscovered", "AttributesObserved", "PriceObserved"]);
  });

  it("the SAME observation twice → exactly one PriceObserved, zero events on the repeat", async () => {
    const first = await kit.runAndApply(kit.initialState, observe());
    expect(first.result.events.filter((e) => e.tag === "PriceObserved")).toHaveLength(1);
    const second = await kit.run(first.newState, observe());
    expect(second.result.events).toHaveLength(0); // no event, no row — dedup is decide, not SQL
  });

  it("a price change → one new PriceObserved and nothing else", async () => {
    const { newState } = await kit.runAndApply(kit.initialState, observe());
    const changed = await kit.run(newState, observe(obs({ pricePerM2: 1350, priceFrom: 324000 })));
    expect(changed.result.events.map((e) => e.tag)).toEqual(["PriceObserved"]);
  });

  it("same price, new pricesAsOf → StalenessObserved only", async () => {
    const { newState } = await kit.runAndApply(kit.initialState, observe());
    const redated = await kit.run(newState, observe(obs({ pricesAsOf: "2026-08-15T00:00:00+00:00" })));
    expect(redated.result.events.map((e) => e.tag)).toEqual(["StalenessObserved"]);
  });

  it("a listing card (pricesAsOf null) after a dated observation → no ping-pong", async () => {
    const { newState } = await kit.runAndApply(kit.initialState, observe());
    const fromListing = await kit.run(newState, observe(obs({ pricesAsOf: null })));
    expect(fromListing.result.events).toHaveLength(0);
    // and the known date survives
    expect(newState.prices["USD"]?.pricesAsOf).toBe("2026-07-22T04:12:53+00:00");
  });

  it("currencies are independent series — never converted, never merged", async () => {
    const usd = await kit.runAndApply(kit.initialState, observe());
    const gelCmd: ProjectCommand = { ...observe(obs({ pricePerM2: 3400, priceFrom: 815000 })), currency: "GEL" } as ProjectCommand;
    const gel = await kit.runAndApply(usd.newState, gelCmd);
    expect(gel.result.events.map((e) => e.tag)).toEqual(["PriceObserved"]);
    expect(gel.newState.prices["USD"]?.pricePerM2).toBe(1300);
    expect(gel.newState.prices["GEL"]?.pricePerM2).toBe(3400);
  });

  it("an observation with no price at all records no PriceObserved", async () => {
    const { result } = await kit.run(kit.initialState, observe(obs({ priceFrom: null, pricePerM2: null, pricesAsOf: null })));
    expect(result.events.map((e) => e.tag)).toEqual(["ProjectDiscovered", "AttributesObserved"]);
  });

  it("a delisted project accepts no further prices", async () => {
    const live = await kit.runAndApply(kit.initialState, observe());
    const delisted = await kit.runAndApply(live.newState, { tag: "MarkDelisted", observedAt: "2026-08-31T00:00:00Z", reason: "404" });
    expect(delisted.result.events.map((e) => e.tag)).toEqual(["ProjectDelisted"]);
    const after = await kit.run(delisted.newState, observe(obs({ pricePerM2: 999 })));
    expect(after.result.events).toHaveLength(0);
    expect(after.result.reply).toEqual({ tag: "Rejected", reason: "project is delisted" });
  });

  it("obs.isDeleted → ProjectDelisted in the same batch", async () => {
    const { result } = await kit.run(kit.initialState, observe(obs({ isDeleted: true })));
    expect(result.events.at(-1)?.tag).toBe("ProjectDelisted");
  });

  it("MarkDelisted on an undiscovered project invents nothing", async () => {
    const { result } = await kit.run(kit.initialState, { tag: "MarkDelisted", observedAt: "2026-08-31T00:00:00Z", reason: "x" });
    expect(result.events).toHaveLength(0);
  });
});

describe("Source aggregate", () => {
  const deps: SourceDeps = {
    fetchSource: () => Promise.reject(new Error("not used in decide tests")),
    saveDistricts: () => {},
    sourceUrl: (id) => `https://korter.ge/en/${id.split(":")[1]}`,
  };
  const aggregate = createSourceAggregate(deps);
  const listingKit = createAggregateTestKit(aggregate, EntityId("listing:new-projects-in-riverside"));
  const projectKit = createAggregateTestKit(aggregate, EntityId("project:parkside-grove-testburg"));
  const avlabari = syntheticListingPage(TESTBURG_LISTING);

  it("FetchOk on a listing → Fetched + MembersChanged, then Observe tells for every card", async () => {
    const { result, record } = await listingKit.run(listingKit.initialState, {
      tag: "FetchOk",
      body: avlabari,
      hash: sha256(avlabari),
      fetchedAt: "2026-08-30T09:24:00Z",
      fromCache: false,
    });
    expect(result.events.map((e) => e.tag)).toEqual(["Fetched", "MembersChanged"]);
    const members = result.events[1];
    if (members?.tag !== "MembersChanged") throw new Error("expected MembersChanged");
    expect(members.added).toHaveLength(11);
    expect(members.removed).toHaveLength(0);

    for (const effect of result.sideEffects) await effect();
    expect(record.sentMessages).toHaveLength(11);
    expect((record.sentMessages[0]?.command as { tag: string }).tag).toBe("Observe");
  });

  it("FetchOk with the same hash → FetchUnchanged, no re-parse, no tells", async () => {
    const hash = sha256(avlabari);
    const fetched = await listingKit.runAndApply(listingKit.initialState, {
      tag: "FetchOk",
      body: avlabari,
      hash,
      fetchedAt: "t1",
      fromCache: false,
    });
    const again = await listingKit.run(fetched.newState, { tag: "FetchOk", body: avlabari, hash, fetchedAt: "t2", fromCache: true });
    expect(again.result.events.map((e) => e.tag)).toEqual(["FetchUnchanged"]);
    for (const effect of again.result.sideEffects) await effect();
    expect(again.record.sentMessages).toHaveLength(0);
  });

  it("an unparseable page → ParseFailed, not a crash", async () => {
    const { result } = await listingKit.run(listingKit.initialState, {
      tag: "FetchOk",
      body: "<html>maintenance</html>",
      hash: "h",
      fetchedAt: "t",
      fromCache: false,
    });
    expect(result.events.map((e) => e.tag)).toEqual(["ParseFailed"]);
  });

  it("403 → FetchRejected, terminal; a second failure adds no second event", async () => {
    const rejected = await listingKit.runAndApply(listingKit.initialState, {
      tag: "FetchFailed",
      failure: { kind: "blocked", detail: "HTTP 403", at: "t" },
    });
    expect(rejected.result.events.map((e) => e.tag)).toEqual(["FetchRejected"]);
    expect(rejected.newState.rejected).toBe(true);
    const again = await listingKit.run(rejected.newState, {
      tag: "FetchFailed",
      failure: { kind: "blocked", detail: "HTTP 403", at: "t2" },
    });
    expect(again.result.events).toHaveLength(0);
  });

  it("404 on a project source → SourceGone + MarkDelisted told to the project", async () => {
    const { result, record } = await projectKit.run(projectKit.initialState, {
      tag: "FetchFailed",
      failure: { kind: "gone", detail: "HTTP 404", at: "t" },
    });
    expect(result.events.map((e) => e.tag)).toEqual(["SourceGone"]);
    for (const effect of result.sideEffects) await effect();
    expect(record.sentMessages).toHaveLength(1);
    expect((record.sentMessages[0]?.command as { tag: string }).tag).toBe("MarkDelisted");
  });

  it("transient failures are not journaled — only terminal outcomes are", async () => {
    const { result } = await listingKit.run(listingKit.initialState, {
      tag: "FetchFailed",
      failure: { kind: "transient", detail: "HTTP 502 after 4 attempts", at: "t" },
    });
    expect(result.events).toHaveLength(0);
  });
});

describe("Tracker aggregate", () => {
  const aggregate = createTrackerAggregate({ sweepIntervalMs: 7 * 24 * 3600 * 1000, now: () => Date.parse("2026-08-30T12:00:00Z") });
  const kit = createAggregateTestKit(aggregate, EntityId("korter"));

  it("Track journals once and is idempotent", async () => {
    const first = await kit.runAndApply(kit.initialState, { tag: "Track", sourceId: "project:tsavkisi-park-tbilisi" });
    expect(first.result.events.map((e) => e.tag)).toEqual(["SourceTracked"]);
    const second = await kit.run(first.newState, { tag: "Track", sourceId: "project:tsavkisi-park-tbilisi" });
    expect(second.result.events).toHaveLength(0);
    expect(second.result.reply).toEqual({ tag: "Ok" });
  });

  it("rejects malformed source ids", async () => {
    const { result } = await kit.run(kit.initialState, { tag: "Track", sourceId: "https://korter.ge/en/foo" });
    expect(result.events).toHaveLength(0);
    expect(result.reply?.tag).toBe("Rejected");
  });

  it("RefreshDue with a tracked set journals SweepStarted and tells every source", async () => {
    let state = kit.initialState;
    for (const sourceId of ["project:a-b", "listing:c-d"]) {
      state = (await kit.runAndApply(state, { tag: "Track", sourceId })).newState;
    }
    const sweep = await kit.run(state, { tag: "RefreshDue" });
    expect(sweep.result.events.map((e) => e.tag)).toEqual(["SweepStarted"]);
    for (const effect of sweep.result.sideEffects) await effect();
    expect(sweep.record.sentMessages.map((m) => m.entityId as string)).toEqual(["project:a-b", "listing:c-d"]);
  });

  it("RefreshDue with nothing tracked does nothing", async () => {
    const { result } = await kit.run(kit.initialState, { tag: "RefreshDue" });
    expect(result.events).toHaveLength(0);
  });

  it("onRecoveryComplete re-arms the sweep timer — missed window sweeps immediately", async () => {
    const armed: { timerId: string; initialDelayMs: number; intervalMs: number }[] = [];
    const { ctx } = createMockControl<TrackerCommand, unknown>(EntityId("korter"), CategoryId("tracker"));
    const recordingCtx: EffectControl<TrackerCommand, never> = {
      ...(ctx as EffectControl<TrackerCommand, never>),
      schedulePeriodic: async (timerId, _command, initialDelayMs, intervalMs) => {
        armed.push({ timerId: timerId as string, initialDelayMs, intervalMs });
      },
    };

    // Sweep 8 days ago with a 7-day interval → overdue → fire now.
    await aggregate.onRecoveryComplete?.(
      { tracked: ["project:a-b"], lastSweepAt: "2026-08-22T12:00:00Z" },
      recordingCtx,
    );
    expect(armed).toHaveLength(1);
    expect(armed[0]?.initialDelayMs).toBe(0);
    expect(armed[0]?.intervalMs).toBe(7 * 24 * 3600 * 1000);

    // Sweep 1 day ago → fire in 6 days.
    await aggregate.onRecoveryComplete?.(
      { tracked: [], lastSweepAt: "2026-08-29T12:00:00Z" },
      recordingCtx,
    );
    expect(armed[1]?.initialDelayMs).toBe(6 * 24 * 3600 * 1000);
  });
});

describe("state invariants (declared on the aggregates)", () => {
  it("project invariants hold along a realistic trace", async () => {
    const kit = createAggregateTestKit(projectAggregate, EntityId("x-y"));
    let state: ProjectState = kit.initialState;
    for (const cmd of [
      observe(),
      observe(obs({ pricePerM2: 1400 })),
      { tag: "MarkDelisted", observedAt: "t", reason: "r" } satisfies ProjectCommand,
    ]) {
      state = (await kit.runAndApply(state, cmd)).newState;
      for (const inv of projectAggregate.invariants ?? []) {
        expect(inv.check(state), inv.name).toBe(true);
      }
    }
  });
});

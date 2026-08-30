/**
 * Property-based invariants (PLAN §7):
 *  - history is monotone in observedAt (commands arrive in time order)
 *  - no PriceObserved without a value change
 *  - a delisted project accepts no further prices
 */
import { runCommandSequence } from "@lambda-house/teob-ts/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { projectAggregate } from "../src/domain/project.js";
import type { ProjectCommand, ProjectEvent } from "../src/domain/types.js";
import { obs, observe } from "./helpers.js";

const priceArb = fc.option(fc.integer({ min: 1, max: 5 }).map((n) => n * 100), { nil: null });
const asOfArb = fc.option(
  fc.integer({ min: 1, max: 4 }).map((i) => `2026-0${i}-01T00:00:00+00:00`),
  { nil: null },
);

const observationArb = fc.record({
  priceFrom: priceArb,
  pricePerM2: priceArb,
  pricesAsOf: asOfArb,
  isDeleted: fc.boolean(),
});

const commandsArb: fc.Arbitrary<ProjectCommand[]> = fc
  .array(
    fc.oneof(
      { weight: 9, arbitrary: observationArb.map((o) => ({ kind: "observe" as const, o })) },
      { weight: 1, arbitrary: fc.constant({ kind: "delist" as const }) },
    ),
    { minLength: 1, maxLength: 25 },
  )
  .map((steps) =>
    steps.map((step, i): ProjectCommand => {
      const at = `2026-08-${String(Math.min(30, i + 1)).padStart(2, "0")}T00:00:00Z`;
      return step.kind === "observe"
        ? observe(obs(step.o), at)
        : { tag: "MarkDelisted", observedAt: at, reason: "prop" };
    }),
  );

describe("journal properties over generated command sequences", () => {
  it("holds the three PLAN §7 properties for arbitrary sequences", async () => {
    await fc.assert(
      fc.asyncProperty(commandsArb, async (commands) => {
        const trace = await runCommandSequence({
          aggregate: projectAggregate,
          aggregateId: "prop-entity",
          commands,
          invariants: projectAggregate.invariants ?? [],
        });

        expect(trace.totalViolations).toBe(0);

        const events: ProjectEvent[] = trace.steps.flatMap((s) => s.events as ProjectEvent[]);

        // 1. monotone in observedAt
        let lastAt = "";
        for (const e of events) {
          expect(e.observedAt >= lastAt, `observedAt regressed: ${e.observedAt} < ${lastAt}`).toBe(true);
          lastAt = e.observedAt;
        }

        // 2. no PriceObserved without a value change
        const lastPrice: Record<string, string> = {};
        for (const e of events) {
          if (e.tag === "PriceObserved") {
            const key = `${e.priceFrom}|${e.pricePerM2}`;
            expect(lastPrice[e.currency], `duplicate PriceObserved for ${e.currency}`).not.toBe(key);
            lastPrice[e.currency] = key;
          }
        }

        // 3. a delisted project accepts no further prices
        let delisted = false;
        for (const e of events) {
          if (e.tag === "ProjectDelisted") delisted = true;
          else if (delisted) {
            expect(e.tag, "event after delisting").toBe("never");
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

/**
 * Tracker aggregate — singleton ("korter"). Owns the tracked set and the weekly
 * sweep schedule.
 *
 * teob-ts timers are in-memory setTimeouts and DO NOT survive a restart.
 * onRecoveryComplete re-arms the sweep on every incarnation, computing the
 * initial delay from lastSweepAt — miss the window while the process was down
 * and the sweep runs immediately. Skipping this hook is the failure mode where
 * the prod deployment silently stops collecting history.
 *
 * Necessary but not sufficient: entities recover LAZILY, on their first
 * command. Every run mode must wake this singleton at boot (seedIfEmpty()'s
 * GetTracked ask does it) or onRecoveryComplete never runs at all — verified
 * empirically by the restart test in test/integration.test.ts.
 */
import {
  type Aggregate,
  andReply,
  andRun,
  done,
  type Effect,
  type EntityId,
  persist,
  reply,
  run,
  TimerId,
} from "@lambda-house/teob-ts/core";
import {
  parseSourceId,
  sourceCategory,
  TRACKER_CATEGORY,
  type TrackerCommand,
  type TrackerEvent,
  type TrackerReply,
  type TrackerState,
} from "./types.js";

export interface TrackerDeps {
  sweepIntervalMs: number;
  now?: () => number;
}

export const SWEEP_TIMER = TimerId("sweep");

export function createTrackerAggregate(
  deps: TrackerDeps,
): Aggregate<TrackerCommand, TrackerReply, TrackerEvent, TrackerState> {
  const now = deps.now ?? (() => Date.now());
  const nowIso = (): string => new Date(now()).toISOString();

  return {
    category: TRACKER_CATEGORY,

    initial(_id: EntityId): TrackerState {
      return { tracked: [], lastSweepAt: null };
    },

    async decide(state, command, ctx): Promise<Effect<TrackerEvent, TrackerReply>> {
      switch (command.tag) {
        case "Track": {
          if (parseSourceId(command.sourceId) === null) {
            return reply({
              tag: "Rejected",
              reason: `invalid source id "${command.sourceId}" — expected listing:<slug> or project:<slug>`,
            });
          }
          if (state.tracked.includes(command.sourceId)) return reply({ tag: "Ok" });
          return andReply(persist({ tag: "SourceTracked", sourceId: command.sourceId, at: nowIso() }), {
            tag: "Ok",
          });
        }

        case "Untrack": {
          if (!state.tracked.includes(command.sourceId)) return reply({ tag: "Ok" });
          return andReply(persist({ tag: "SourceUntracked", sourceId: command.sourceId, at: nowIso() }), {
            tag: "Ok",
          });
        }

        case "RefreshDue":
        case "RefreshNow": {
          if (command.tag === "RefreshNow" && command.sourceId !== undefined) {
            const sourceId = command.sourceId;
            if (parseSourceId(sourceId) === null) {
              return reply({ tag: "Rejected", reason: `invalid source id "${sourceId}"` });
            }
            return andReply(
              run<TrackerEvent, TrackerReply>(() =>
                ctx.tell(sourceId as EntityId, { tag: "Refresh", force: false }, sourceCategory),
              ),
              { tag: "Ok" },
            );
          }
          if (state.tracked.length === 0) {
            return command.tag === "RefreshNow" ? reply({ tag: "Ok" }) : done();
          }
          const sourceIds = [...state.tracked];
          const at = nowIso();
          const effect = andRun(
            persist<TrackerEvent, TrackerReply>({ tag: "SweepStarted", sourceIds, at }),
            async () => {
              for (const sourceId of sourceIds) {
                await ctx.tell(sourceId as EntityId, { tag: "Refresh", force: false }, sourceCategory);
              }
            },
          );
          return command.tag === "RefreshNow" ? andReply(effect, { tag: "Ok" }) : effect;
        }

        case "GetTracked":
          return reply({ tag: "Tracked", sourceIds: [...state.tracked], lastSweepAt: state.lastSweepAt });
      }
    },

    apply(state, event): TrackerState {
      switch (event.tag) {
        case "SourceTracked":
          return { ...state, tracked: [...state.tracked, event.sourceId] };
        case "SourceUntracked":
          return { ...state, tracked: state.tracked.filter((s) => s !== event.sourceId) };
        case "SweepStarted":
          return { ...state, lastSweepAt: event.at };
      }
    },

    async onRecoveryComplete(state, ctx): Promise<void> {
      // Mandatory re-arm (see module header). Missed window → sweep now.
      const last = state.lastSweepAt ? Date.parse(state.lastSweepAt) : null;
      const nextDue = last === null ? now() : last + deps.sweepIntervalMs;
      const initialDelayMs = Math.max(0, nextDue - now());
      ctx.log("info", `tracker: arming sweep timer, first in ${Math.round(initialDelayMs / 1000)}s`);
      await ctx.schedulePeriodic(SWEEP_TIMER, { tag: "RefreshDue" }, initialDelayMs, deps.sweepIntervalMs);
    },

    invariants: [
      {
        name: "tracked set has no duplicates",
        check: (state) => new Set(state.tracked).size === state.tracked.length,
      },
      {
        name: "tracked ids are well-formed",
        check: (state) => state.tracked.every((s) => parseSourceId(s) !== null),
      },
    ],
  };
}

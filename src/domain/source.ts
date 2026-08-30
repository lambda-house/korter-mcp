/**
 * Source aggregate — one entity per fetched korter page. Owns the fetch
 * lifecycle: Refresh → paced/cached fetch via ctx.sync → FetchOk/FetchFailed →
 * journal the outcome, tell every extracted project to Observe.
 *
 * FetchRejected (403/429) is terminal by design: the breaker is already open
 * (the client tripped it), the event records why, and nothing retries. That is
 * CLAUDE.md hard rule 1 made structural.
 */
import {
  type Aggregate,
  andRun,
  createDeferredReply,
  done,
  type Effect,
  type EffectControl,
  type Either,
  type EntityId,
  persist,
  replyDeferred,
  run,
} from "@lambda-house/teob-ts/core";
import { extractPage } from "../parse/extract.js";
import { type ListingPage, ParseError, type SecondaryPage } from "../parse/types.js";
import {
  type FetchFailure,
  type FetchSuccess,
  parseSourceId,
  projectCategory,
  type RefreshOutcome,
  type SecondaryStats,
  SOURCE_CATEGORY,
  type SourceCommand,
  type SourceEvent,
  type SourceReply,
  type SourceState,
} from "./types.js";

export interface SourceDeps {
  /** Cache-first, robots-checked, paced fetch of the page behind a source id. */
  fetchSource(sourceId: string, force: boolean): Promise<Either<FetchFailure, FetchSuccess>>;
  /** Persist korter's district taxonomy (plain reference table, not journaled). */
  saveDistricts(page: ListingPage, fetchedAt: string): void;
  /** Replace the secondary-market snapshot for this source (plain table). */
  saveSecondary(sourceId: string, page: SecondaryPage, fetchedAt: string): void;
  /** Absolute URL for the envelope. */
  sourceUrl(sourceId: string): string;
  /** How long a Refresh may sit in the paced queue before giving up. */
  fetchTimeoutMs?: number;
}

export function createSourceAggregate(
  deps: SourceDeps,
): Aggregate<SourceCommand, SourceReply, SourceEvent, SourceState> {
  // Refresh callers (the refresh tool, the sweep script) await the terminal
  // outcome via a deferred reply. Kept in memory by design: after a crash the
  // asker's timeout is the answer.
  const waiting = new Map<string, Array<(outcome: RefreshOutcome) => void>>();

  const settle = (id: string, outcome: RefreshOutcome): void => {
    const list = waiting.get(id) ?? [];
    waiting.delete(id);
    for (const complete of list) complete(outcome);
  };

  return {
    category: SOURCE_CATEGORY,

    initial(_id: EntityId): SourceState {
      return { lastHash: null, lastFetchedAt: null, members: [], rejected: false, gone: false };
    },

    // Snapshot every event: state is tiny, and it makes Source-category
    // retention safe — recovery is snapshot + tail, never a replay through
    // events that retention may have pruned (lastHash/members would silently
    // reset and re-emit spurious Fetched/MembersChanged).
    snapshotEvery: 1,

    async decide(state, command, ctx): Promise<Effect<SourceEvent, SourceReply>> {
      const id = ctx.entityId as string;
      switch (command.tag) {
        case "Refresh": {
          if (state.rejected) {
            // The journal says korter blocked us. Stay stopped until a human
            // restarts the process (which resets the in-memory breaker).
            return replySettled({ tag: "Failed", kind: "blocked", detail: "source has a FetchRejected on record" });
          }
          await ctx.sync<FetchSuccess, FetchFailure>({
            effect: () => deps.fetchSource(id, command.force),
            onSuccess: (s) => ({ tag: "FetchOk", body: s.body, hash: s.hash, fetchedAt: s.fetchedAt, fromCache: s.fromCache }),
            onFailure: (f) => ({ tag: "FetchFailed", failure: f }),
            timeoutMs: deps.fetchTimeoutMs ?? 120_000,
            onTimeout: {
              tag: "FetchFailed",
              failure: { kind: "transient", detail: "fetch timed out in the paced queue", at: new Date().toISOString() },
            },
          });
          const deferred = createDeferredReply<SourceReply>();
          const list = waiting.get(id) ?? [];
          list.push((outcome) => deferred.complete({ tag: "Done", outcome }));
          waiting.set(id, list);
          return replyDeferred(deferred);
        }

        case "FetchOk":
          return handleFetchOk(state, command, ctx, id);

        case "FetchFailed":
          return handleFetchFailed(state, command.failure, ctx, id);
      }
    },

    apply(state, event): SourceState {
      switch (event.tag) {
        case "Fetched":
          return { ...state, lastHash: event.hash, lastFetchedAt: event.fetchedAt };
        case "FetchUnchanged":
          return { ...state, lastFetchedAt: event.fetchedAt };
        case "MembersChanged": {
          const withoutRemoved = state.members.filter((m) => !event.removed.includes(m));
          return { ...state, members: [...withoutRemoved, ...event.added].sort() };
        }
        case "SecondaryMarketObserved":
          return { ...state, lastSecondary: event.stats };
        case "FetchRejected":
          return { ...state, rejected: true };
        case "SourceGone":
          return { ...state, gone: true };
        case "ParseFailed":
          return state;
      }
    },
  };

  function handleFetchOk(
    state: SourceState,
    cmd: { body: string; hash: string; fetchedAt: string; fromCache: boolean },
    ctx: EffectControl<SourceCommand, SourceReply>,
    id: string,
  ): Effect<SourceEvent, SourceReply> {
    if (cmd.hash === state.lastHash) {
      return andRun(persist<SourceEvent, SourceReply>({ tag: "FetchUnchanged", fetchedAt: cmd.fetchedAt }), async () =>
        settle(id, { tag: "Unchanged", fetchedAt: cmd.fetchedAt }),
      );
    }

    let page;
    try {
      page = extractPage(cmd.body);
    } catch (e) {
      const reason = e instanceof ParseError ? e.reason : e instanceof Error ? e.message : String(e);
      return andRun(persist<SourceEvent, SourceReply>({ tag: "ParseFailed", reason, at: cmd.fetchedAt }), async () =>
        settle(id, { tag: "ParseFailed", reason }),
      );
    }

    const events: SourceEvent[] = [
      { tag: "Fetched", hash: cmd.hash, fetchedAt: cmd.fetchedAt, bytes: cmd.body.length },
    ];

    if (page.pageType === "listing") {
      const seen = page.projects.map((p) => p.slug).sort();
      const added = seen.filter((s) => !state.members.includes(s));
      const removed = state.members.filter((s) => !seen.includes(s));
      if (added.length > 0 || removed.length > 0) {
        events.push({ tag: "MembersChanged", added, removed, observedAt: cmd.fetchedAt });
      }
    }

    if (page.pageType === "secondary") {
      const stats = secondaryStats(page);
      const prev = state.lastSecondary ?? null;
      if (JSON.stringify(stats) !== JSON.stringify(prev)) {
        events.push({ tag: "SecondaryMarketObserved", stats, observedAt: cmd.fetchedAt });
      }
    }

    const observed = page;
    return andRun(persist<SourceEvent, SourceReply>(...events), async () => {
      if (observed.pageType === "listing") deps.saveDistricts(observed, cmd.fetchedAt);
      if (observed.pageType === "secondary") {
        deps.saveSecondary(id, observed, cmd.fetchedAt);
        settle(id, {
          tag: "Fetched",
          fetchedAt: cmd.fetchedAt,
          projects: observed.listings.length,
          fromCache: cmd.fromCache,
        });
        return;
      }
      for (const obs of observed.projects) {
        await ctx.tell(
          obs.slug as EntityId,
          {
            tag: "Observe",
            obs,
            currency: observed.currency,
            sourceUrl: deps.sourceUrl(id),
            sourceHash: cmd.hash,
            observedAt: cmd.fetchedAt,
          },
          projectCategory,
        );
      }
      settle(id, {
        tag: "Fetched",
        fetchedAt: cmd.fetchedAt,
        projects: observed.projects.length,
        fromCache: cmd.fromCache,
      });
    });
  }

  function secondaryStats(page: SecondaryPage): SecondaryStats {
    const focus = page.aggregates.find((a) => a.id === page.focusDistrictId) ?? null;
    const perM2 = page.listings
      .map((l) => l.pricePerM2)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);
    return {
      section: page.section,
      districtId: page.focusDistrictId,
      district: page.focusDistrictName ?? focus?.name ?? null,
      listingCount: page.totalCount,
      avgPriceSqm: focus?.avgPriceSqm ?? null,
      sampleMedianPriceSqm: perM2.length > 0 ? perM2[Math.floor(perM2.length / 2)]! : null,
      currency: page.currency,
    };
  }

  function handleFetchFailed(
    state: SourceState,
    failure: FetchFailure,
    ctx: EffectControl<SourceCommand, SourceReply>,
    id: string,
  ): Effect<SourceEvent, SourceReply> {
    const fail = (): void => settle(id, { tag: "Failed", kind: failure.kind, detail: failure.detail });

    switch (failure.kind) {
      case "blocked":
      case "ratelimited": {
        if (state.rejected) return run(async () => fail());
        return andRun(
          persist<SourceEvent, SourceReply>({ tag: "FetchRejected", kind: failure.kind, at: failure.at }),
          async () => fail(),
        );
      }
      case "gone": {
        const parsed = parseSourceId(id);
        const events: Effect<SourceEvent, SourceReply> = state.gone
          ? run(async () => fail())
          : andRun(persist<SourceEvent, SourceReply>({ tag: "SourceGone", at: failure.at }), async () => {
              if (parsed?.kind === "project") {
                await ctx.tell(
                  parsed.slug as EntityId,
                  { tag: "MarkDelisted", observedAt: failure.at, reason: "korter returns 404 for the page" },
                  projectCategory,
                );
              }
              fail();
            });
        return events;
      }
      default:
        // Transient/breaker/robots outcomes are not journaled per BRIEF §3 —
        // only terminal lifecycle facts are. The caller still learns why.
        return run(async () => fail());
    }
  }

  function replySettled(outcome: RefreshOutcome): Effect<SourceEvent, SourceReply> {
    const deferred = createDeferredReply<SourceReply>();
    deferred.complete({ tag: "Done", outcome });
    return replyDeferred(deferred);
  }
}

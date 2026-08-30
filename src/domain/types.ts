/**
 * Commands, events, replies and state for the three aggregates, plus codecs.
 *
 * Events are append-only. The shapes follow BRIEF.md §3 with the Phase 0
 * amendments recorded in docs/schema-notes.md: AttributesObserved gained
 * city/constructionStatus/salesStatus/buildingType/korterId, StalenessObserved
 * is keyed by currency, and pricesAsOf:null means "korter showed no date"
 * (listing cards) — it never overwrites a known date.
 */
import { CategoryId, categoryTypes, objectCodec, tagCodec } from "@lambda-house/teob-ts/core";
import type { Currency, ProjectObservation, UnitTypeObservation } from "../parse/types.js";

// ---------------------------------------------------------------------------
// Project — entity per korter slug; its journal IS the price history
// ---------------------------------------------------------------------------

export const PROJECT_CATEGORY = CategoryId("project");

export interface ObservedAttrs {
  name?: string;
  address?: string;
  district?: string;
  city?: string;
  developer?: string;
  lat?: number;
  lng?: number;
  constructionStatus?: string;
  salesStatus?: string;
  buildingType?: string;
  korterId?: number;
  /** korter's finish state, e.g. "green frame". Added 2026-08-30 (optional — no upcast needed). */
  renovation?: string;
}

export type ProjectCommand =
  | {
      tag: "Observe";
      obs: ProjectObservation;
      currency: Currency;
      sourceUrl: string;
      sourceHash: string;
      observedAt: string;
    }
  | { tag: "MarkDelisted"; observedAt: string; reason: string };

export type ProjectReply = { tag: "Ok" } | { tag: "Rejected"; reason: string };

export type ProjectEvent =
  | { tag: "ProjectDiscovered"; slug: string; sourceUrl: string; observedAt: string }
  | ({ tag: "AttributesObserved"; observedAt: string } & ObservedAttrs)
  | {
      tag: "PriceObserved";
      priceFrom: number | null;
      pricePerM2: number | null;
      currency: Currency;
      pricesAsOf: string | null;
      observedAt: string;
      sourceUrl: string;
      sourceHash: string;
    }
  | { tag: "StalenessObserved"; currency: Currency; pricesAsOf: string; observedAt: string }
  /**
   * The per-unit breakdown (rooms/areas/price ranges) from a project page,
   * journaled only when the set changes. Added 2026-08-30 for area/room search
   * criteria — additive, append-only.
   */
  | { tag: "UnitTypesObserved"; unitTypes: UnitTypeObservation[]; currency: Currency; observedAt: string }
  | { tag: "ProjectDelisted"; observedAt: string; reason: string };

export interface PriceState {
  priceFrom: number | null;
  pricePerM2: number | null;
  pricesAsOf: string | null;
  observedAt: string;
  sourceUrl: string;
}

export interface ProjectState {
  discovered: boolean;
  attrs: ObservedAttrs;
  attrsObservedAt: string | null;
  prices: Partial<Record<Currency, PriceState>>;
  /** null until a project page has been observed (listing cards carry none). */
  unitTypes: UnitTypeObservation[] | null;
  unitTypesObservedAt: string | null;
  delisted: boolean;
  discoveredAt: string | null;
}

export const projectCategory = categoryTypes<ProjectCommand, ProjectReply>(PROJECT_CATEGORY);
export const projectEventCodec = tagCodec<ProjectEvent>(
  "ProjectDiscovered",
  "AttributesObserved",
  "PriceObserved",
  "StalenessObserved",
  "UnitTypesObserved",
  "ProjectDelisted",
);
export const projectCommandCodec = tagCodec<ProjectCommand>("Observe", "MarkDelisted");
export const projectStateCodec = objectCodec<ProjectState>("ProjectState");

// ---------------------------------------------------------------------------
// Source — entity per fetched page ("listing:<slug>" | "project:<slug>")
// ---------------------------------------------------------------------------

export const SOURCE_CATEGORY = CategoryId("source");

export interface FetchSuccess {
  body: string;
  hash: string;
  fetchedAt: string;
  fromCache: boolean;
}

export type FetchFailureKind = "blocked" | "ratelimited" | "gone" | "transient" | "breaker" | "robots";

export interface FetchFailure {
  kind: FetchFailureKind;
  detail: string;
  at: string;
}

export type SourceCommand =
  | { tag: "Refresh"; force: boolean }
  | { tag: "FetchOk"; body: string; hash: string; fetchedAt: string; fromCache: boolean }
  | { tag: "FetchFailed"; failure: FetchFailure };

/** The outcome a refresh caller (tool or sweep script) awaits. */
export type RefreshOutcome =
  | { tag: "Fetched"; fetchedAt: string; projects: number; fromCache: boolean }
  | { tag: "Unchanged"; fetchedAt: string }
  | { tag: "ParseFailed"; reason: string }
  | { tag: "Failed"; kind: FetchFailureKind; detail: string };

export type SourceReply = { tag: "Refreshing" } | { tag: "Done"; outcome: RefreshOutcome };

/**
 * Compact secondary-market aggregate for the district a secondary source is
 * scoped to. Individual listings are NOT journaled (ephemeral — see the
 * secondary snapshot table); the market-level trend is the durable fact.
 */
export interface SecondaryStats {
  section: "sale" | "rent";
  districtId: number | null;
  district: string | null;
  listingCount: number | null;
  /** korter's own district average when its page carries it (usually not for the focus district). */
  avgPriceSqm: number | null;
  /** Median price/m2 of THIS page's listing sample — our own observed figure. */
  sampleMedianPriceSqm: number | null;
  currency: Currency;
}

export type SourceEvent =
  | { tag: "Fetched"; hash: string; fetchedAt: string; bytes: number }
  | { tag: "FetchUnchanged"; fetchedAt: string }
  | { tag: "MembersChanged"; added: string[]; removed: string[]; observedAt: string }
  | { tag: "SecondaryMarketObserved"; stats: SecondaryStats; observedAt: string }
  | { tag: "FetchRejected"; kind: "blocked" | "ratelimited"; at: string }
  | { tag: "SourceGone"; at: string }
  | { tag: "ParseFailed"; reason: string; at: string };

export interface SourceState {
  lastHash: string | null;
  lastFetchedAt: string | null;
  /** Project slugs on a listing page, for MembersChanged diffs. */
  members: string[];
  /** Last journaled secondary aggregate (dedup); optional — older snapshots lack it. */
  lastSecondary?: SecondaryStats | null;
  rejected: boolean;
  gone: boolean;
}

export const sourceCategory = categoryTypes<SourceCommand, SourceReply>(SOURCE_CATEGORY);
export const sourceEventCodec = tagCodec<SourceEvent>(
  "Fetched",
  "FetchUnchanged",
  "MembersChanged",
  "SecondaryMarketObserved",
  "FetchRejected",
  "SourceGone",
  "ParseFailed",
);
export const sourceStateCodec = objectCodec<SourceState>("SourceState");

/**
 * "listing:new-projects-in-avlabari" → { kind: "listing", slug, path }.
 * `secondary:` covers both sale and rent pages
 * (e.g. secondary:apartments-sale-tbilisi-vake-district,
 *  secondary:apartments-for-rent-tbilisi-vake).
 */
export function parseSourceId(
  sourceId: string,
): { kind: "listing" | "project" | "secondary"; slug: string; path: string } | null {
  const m = /^(listing|project|secondary):([a-z0-9][a-z0-9-]*)$/.exec(sourceId);
  if (!m) return null;
  return { kind: m[1] as "listing" | "project" | "secondary", slug: m[2]!, path: `/en/${m[2]}` };
}

// ---------------------------------------------------------------------------
// Tracker — singleton ("korter"): the tracked set and the sweep schedule
// ---------------------------------------------------------------------------

export const TRACKER_CATEGORY = CategoryId("tracker");
export const TRACKER_ID = "korter";

export type TrackerCommand =
  | { tag: "Track"; sourceId: string }
  | { tag: "Untrack"; sourceId: string }
  | { tag: "RefreshDue" }
  | { tag: "RefreshNow"; sourceId?: string }
  | { tag: "GetTracked" };

export type TrackerReply =
  | { tag: "Ok" }
  | { tag: "Rejected"; reason: string }
  | { tag: "Tracked"; sourceIds: string[]; lastSweepAt: string | null };

export type TrackerEvent =
  | { tag: "SourceTracked"; sourceId: string; at: string }
  | { tag: "SourceUntracked"; sourceId: string; at: string }
  | { tag: "SweepStarted"; sourceIds: string[]; at: string };

export interface TrackerState {
  tracked: string[];
  lastSweepAt: string | null;
}

export const trackerCategory = categoryTypes<TrackerCommand, TrackerReply>(TRACKER_CATEGORY);
export const trackerEventCodec = tagCodec<TrackerEvent>("SourceTracked", "SourceUntracked", "SweepStarted");
export const trackerStateCodec = objectCodec<TrackerState>("TrackerState");

/** Fixture-verified seed set; unverified candidate slugs stay out (track them later). */
export const SEED_SOURCES = [
  "project:tsavkisi-park-tbilisi",
  "project:ambience-avlabari-tbilisi",
  "listing:new-projects-in-avlabari",
] as const;

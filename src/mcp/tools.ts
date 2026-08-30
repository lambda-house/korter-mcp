/**
 * MCP tool definitions over the read views and the aggregates.
 *
 * Reads (search_projects, get_project, list_districts, price_history,
 * diff_report) are served from projections and journal queries — never from an
 * aggregate. Commands (refresh, track, untrack) ask an aggregate and report
 * the accepted/rejected outcome. Refreshing is an action, not a `force` flag
 * on every read.
 */
import type { EntityId, EntityRuntime, JournalReader } from "@lambda-house/teob-ts/core";
import type { MCPTool } from "@lambda-house/teob-ts/ai";
import type { ProjectionStore } from "@lambda-house/teob-ts/projection";
import { MCPToolResultFactory as MCPToolResult, type MCPToolResult as MCPToolResultValue, type MCPToolRegistry } from "@lambda-house/teob-ts/ai";
import { KORTER_ORIGIN } from "../config.js";
import {
  parseSourceId,
  type RefreshOutcome,
  SEED_SOURCES,
  type SecondaryStats,
  sourceCategory,
  TRACKER_ID,
  trackerCategory,
  type TrackerReply,
} from "../domain/types.js";
import {
  hasTermsConsent,
  type Interest,
  PRIVACY_VERSION,
  userCategory,
  type UserEvent,
  type UserReply,
  type UserState,
} from "../domain/user.js";
import type { Currency } from "../parse/types.js";
import { CATALOG_PROJECTION_ID, type CatalogCard } from "../views/catalog.js";
import type { DistrictStore } from "../views/districts.js";
import { diffReport, priceHistory } from "../views/history.js";
import type { SecondaryRow, SecondaryStore } from "../views/secondary.js";
import { cardEnvelope, stalenessDays } from "./envelope.js";
import { currentIdentity, type Identity } from "./identity.js";
import { getSkill, SKILLS, skillIndex } from "./skills.js";

export interface ToolDeps {
  runtime: EntityRuntime;
  reader: JournalReader;
  store: ProjectionStore;
  districts: DistrictStore;
  secondary: SecondaryStore;
  /** Fold any freshly journaled events into projections, synchronously. */
  refreshProjections: () => void;
  now?: () => number;
}

/**
 * Access tiers, applied per authenticated end user (identity via Pomerium).
 * The local stdio process and the operator are ungated:
 *  - open:     usable before consent (consent, my_data, get_skill)
 *  - read:     requires terms consent for the CURRENT notice version
 *  - command:  operator only — end users never trigger korter fetches, so
 *              korter load stays independent of the user count
 *  - operator: operator only (user administration)
 */
type Tier = "open" | "read" | "command" | "operator";

const TIERS: Record<string, Tier> = {
  get_skill: "open",
  consent: "open",
  my_data: "open",
  search_projects: "read",
  get_project: "read",
  list_districts: "read",
  price_history: "read",
  diff_report: "read",
  search_secondary: "read",
  secondary_trends: "read",
  refresh: "command",
  track: "command",
  untrack: "command",
  list_tracked: "read",
  list_users: "operator",
};

/** Which search criteria a call reveals — the consented interest profile. */
const INTEREST_OF: Record<string, (args: Record<string, unknown>) => Interest> = {
  search_projects: (a) => pickInterest("search_projects", a),
  search_secondary: (a) => pickInterest("search_secondary", a),
  get_project: (a) => ({ tool: "get_project", slug: typeof a["slug"] === "string" ? a["slug"] : undefined }),
  price_history: (a) => ({ tool: "price_history", slug: typeof a["slug"] === "string" ? a["slug"] : undefined }),
};

function pickInterest(tool: string, a: Record<string, unknown>): Interest {
  const numArg = (k: string): number | undefined => (typeof a[k] === "number" ? (a[k] as number) : undefined);
  const strArg = (k: string): string | undefined => (typeof a[k] === "string" ? (a[k] as string) : undefined);
  return {
    tool,
    section: strArg("section"),
    district: strArg("district"),
    city: strArg("city"),
    rooms: numArg("rooms") ?? numArg("min_rooms"),
    minAreaM2: numArg("min_area_m2"),
    maxAreaM2: numArg("max_area_m2"),
    maxBudget: numArg("max_budget") ?? numArg("max_price"),
    maxPricePerM2: numArg("max_price_per_m2"),
  };
}

const CURRENCY = { type: "string", enum: ["USD", "GEL"] };

export function registerKorterTools(registry: MCPToolRegistry, deps: ToolDeps): void {
  const now = deps.now ?? (() => Date.now());

  registry.register({
    name: "get_skill",
    description:
      "Fetch usage guidance for this server before composing non-trivial queries. Skills: " +
      skillIndex() +
      ". Call with the skill name; call 'apartment-search' before any multi-criteria search.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", enum: SKILLS.map((s) => s.name) } },
      required: ["name"],
      additionalProperties: false,
    },
    execute: (input) => {
      const { name } = input as { name: string };
      const skill = getSkill(name);
      if (!skill) {
        return Promise.resolve(MCPToolResult.failure(`Unknown skill "${name}". Available: ${skillIndex()}`));
      }
      return Promise.resolve(MCPToolResult.success(skill.body));
    },
  });

  // Views written by an older build may predate newer CatalogCard fields —
  // defaults first, stored values win. undefined must never impersonate data.
  const normalizeCard = (view: CatalogCard): CatalogCard => ({
    ...view,
    unitTypes: view.unitTypes ?? null,
    unitTypesObservedAt: view.unitTypesObservedAt ?? null,
  });
  const cards = (): CatalogCard[] =>
    deps.store.list<CatalogCard>(CATALOG_PROJECTION_ID).map((e) => normalizeCard(e.view));

  const cardResult = (card: CatalogCard, currency: Currency): Record<string, unknown> => {
    const price = card.prices[currency];
    const units = card.unitTypes;
    return {
      slug: card.slug,
      name: card.attrs.name ?? null,
      district: card.attrs.district ?? null,
      city: card.attrs.city ?? null,
      developer: card.attrs.developer ?? null,
      construction_status: card.attrs.constructionStatus ?? null,
      sales_status: card.attrs.salesStatus ?? null,
      building_type: card.attrs.buildingType ?? null,
      renovation: card.attrs.renovation ?? null,
      currency,
      price_from: price?.priceFrom ?? null,
      price_per_m2: price?.pricePerM2 ?? null,
      // Per-unit summary — null means "project page not observed yet", so
      // room/area filters could not consider this card; refresh project:<slug>.
      unit_data: units !== null,
      rooms_available: units ? [...new Set(units.filter((u) => !u.allSold).map((u) => u.roomCount).filter((r): r is number => r !== null))].sort((a, b) => a - b) : null,
      area_range_m2: units && units.length > 0 ? [
        Math.min(...units.map((u) => u.areaMin ?? Infinity)),
        Math.max(...units.map((u) => u.areaMax ?? -Infinity)),
      ].map((v) => (Number.isFinite(v) ? v : null)) : null,
      delisted: card.delisted,
      ...cardEnvelope(card, currency, now()),
    };
  };

  registry.register({
    name: "search_projects",
    description:
      "Search observed Tbilisi new-build projects. Criteria: district/city (korter's taxonomy, as-is), " +
      "price per m² and total budget, rooms and unit area (need per-unit data — see get_skill " +
      "'apartment-search'), construction/sales status, building type, developer, free text. " +
      "Served from the local journal — check staleness_days on every result. " +
      "Room/area filters only consider projects whose project page has been observed; " +
      "candidates lacking that data are listed separately so you can refresh them.",
    inputSchema: {
      type: "object",
      properties: {
        district: { type: "string", description: "korter district name, e.g. 'Vake', 'Isani' (their taxonomy, as-is)" },
        city: { type: "string" },
        q: { type: "string", description: "substring match on name, address, developer or slug" },
        min_price_per_m2: { type: "number" },
        max_price_per_m2: { type: "number" },
        max_budget: { type: "number", description: "total price cap — matches price_from or any unit's minimum price" },
        rooms: { type: "number", description: "exact room count of at least one available unit type" },
        min_rooms: { type: "number" },
        min_area_m2: { type: "number", description: "unit area range must overlap [min_area_m2, max_area_m2]" },
        max_area_m2: { type: "number" },
        construction_status: { type: "string", description: "'construction' | 'ready' (korter's values)" },
        building_type: { type: "string", description: "e.g. 'cottage'" },
        developer: { type: "string", description: "substring match on developer name" },
        currency: { ...CURRENCY, description: "price currency, default USD (korter's /en/ pages price in USD)" },
        include_delisted: { type: "boolean", default: false },
        include_sold_out_units: { type: "boolean", default: false, description: "count allSold unit types when matching rooms/area" },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        count: { type: "number" },
        projects: { type: "array" },
        needs_unit_data: { type: "array", description: "slugs passing card-level filters but lacking per-unit data for rooms/area criteria" },
      },
    },
    execute: (input) => {
      const args = input as {
        district?: string;
        city?: string;
        q?: string;
        min_price_per_m2?: number;
        max_price_per_m2?: number;
        max_budget?: number;
        rooms?: number;
        min_rooms?: number;
        min_area_m2?: number;
        max_area_m2?: number;
        construction_status?: string;
        building_type?: string;
        developer?: string;
        currency?: Currency;
        include_delisted?: boolean;
        include_sold_out_units?: boolean;
      };
      const currency: Currency = args.currency ?? "USD";
      const eq = (a: string | undefined, b: string | undefined): boolean =>
        a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
      const has = (a: string | undefined, needle: string | undefined): boolean =>
        a !== undefined && needle !== undefined && a.toLowerCase().includes(needle.toLowerCase());
      const text = args.q?.toLowerCase();
      const wantsUnitData =
        args.rooms !== undefined ||
        args.min_rooms !== undefined ||
        args.min_area_m2 !== undefined ||
        args.max_area_m2 !== undefined;

      const cardLevelPass = (card: CatalogCard): boolean => {
        if (card.delisted && args.include_delisted !== true) return false;
        if (args.district !== undefined && !eq(card.attrs.district, args.district)) return false;
        if (args.city !== undefined && !eq(card.attrs.city, args.city)) return false;
        if (args.construction_status !== undefined && !eq(card.attrs.constructionStatus, args.construction_status)) return false;
        if (args.building_type !== undefined && !eq(card.attrs.buildingType, args.building_type)) return false;
        if (args.developer !== undefined && !has(card.attrs.developer, args.developer)) return false;
        const price = card.prices[currency];
        const perM2 = price?.pricePerM2 ?? null;
        if (args.max_price_per_m2 !== undefined && (perM2 === null || perM2 > args.max_price_per_m2)) return false;
        if (args.min_price_per_m2 !== undefined && (perM2 === null || perM2 < args.min_price_per_m2)) return false;
        if (args.max_budget !== undefined) {
          const cheapestUnit = card.unitTypes
            ? Math.min(...card.unitTypes.map((u) => u.priceMin ?? Infinity))
            : Infinity;
          const from = Math.min(price?.priceFrom ?? Infinity, cheapestUnit);
          if (!(from <= args.max_budget)) return false;
        }
        if (text !== undefined) {
          const haystack = [card.attrs.name, card.attrs.address, card.attrs.developer, card.slug]
            .filter((s): s is string => typeof s === "string")
            .join(" ")
            .toLowerCase();
          if (!haystack.includes(text)) return false;
        }
        return true;
      };

      const unitPass = (card: CatalogCard): boolean => {
        if (!wantsUnitData) return true;
        const units = (card.unitTypes ?? []).filter((u) => args.include_sold_out_units === true || !u.allSold);
        return units.some((u) => {
          if (args.rooms !== undefined && u.roomCount !== args.rooms) return false;
          if (args.min_rooms !== undefined && (u.roomCount === null || u.roomCount < args.min_rooms)) return false;
          const lo = args.min_area_m2 ?? 0;
          const hi = args.max_area_m2 ?? Infinity;
          if (args.min_area_m2 !== undefined || args.max_area_m2 !== undefined) {
            if (u.areaMin === null && u.areaMax === null) return false;
            const uLo = u.areaMin ?? u.areaMax ?? 0;
            const uHi = u.areaMax ?? u.areaMin ?? Infinity;
            if (uHi < lo || uLo > hi) return false; // ranges must overlap
          }
          return true;
        });
      };

      const passing = cards().filter(cardLevelPass);
      const matches = passing.filter((c) => (wantsUnitData ? c.unitTypes !== null && unitPass(c) : true));
      const needsUnitData = wantsUnitData ? passing.filter((c) => c.unitTypes === null).map((c) => c.slug) : [];

      matches.sort((a, b) => (a.prices[currency]?.pricePerM2 ?? Infinity) - (b.prices[currency]?.pricePerM2 ?? Infinity));
      return Promise.resolve(
        MCPToolResult.success({
          count: matches.length,
          projects: matches.map((c) => cardResult(c, currency)),
          ...(needsUnitData.length > 0
            ? {
                needs_unit_data: needsUnitData,
                hint: "These match every card-level criterion but their project pages have not been observed, so rooms/area are unknown. Refresh a shortlist (refresh with project:<slug>, at most ~10) and search again.",
              }
            : {}),
        }),
      );
    },
  });

  registry.register({
    name: "get_project",
    description:
      "Full card for one project by korter slug: attributes, latest price per currency, coordinates, " +
      "history summary. Check staleness_days — korter itself displays months-old prices.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string", description: "korter slug, e.g. 'tsavkisi-park-tbilisi'" } },
      required: ["slug"],
      additionalProperties: false,
    },
    execute: (input) => {
      const { slug } = input as { slug: string };
      const envelopeView = deps.store.get<CatalogCard>(CATALOG_PROJECTION_ID, slug);
      if (!envelopeView) {
        return Promise.resolve(
          MCPToolResult.failure(
            `No observations for "${slug}". If the slug is right, run refresh with source_id "project:${slug}" first.`,
          ),
        );
      }
      const card = normalizeCard(envelopeView.view);
      const nowMs = now();
      const prices = Object.fromEntries(
        Object.entries(card.prices).map(([cur, p]) => [
          cur,
          {
            price_from: p.priceFrom,
            price_per_m2: p.pricePerM2,
            prices_as_of: p.pricesAsOf,
            observed_at: p.observedAt,
            source_url: p.sourceUrl,
            staleness_days: stalenessDays(p.pricesAsOf ?? p.observedAt, nowMs),
          },
        ]),
      );
      return Promise.resolve(
        MCPToolResult.success({
          slug: card.slug,
          attributes: card.attrs,
          coordinates: card.attrs.lat !== undefined ? { lat: card.attrs.lat, lng: card.attrs.lng } : null,
          prices,
          unit_types:
            card.unitTypes?.map((u) => ({
              name: u.name,
              property_type: u.propertyType,
              rooms: u.roomCount,
              area_m2: [u.areaMin, u.areaMax],
              price_range: [u.priceMin, u.priceMax],
              price_per_m2_from: u.pricePerM2Min,
              all_sold: u.allSold,
            })) ?? null,
          unit_types_observed_at: card.unitTypesObservedAt,
          delisted: card.delisted,
          discovered_at: card.discoveredAt,
          ...cardEnvelope(card, "USD", nowMs),
        }),
      );
    },
  });

  registry.register({
    name: "list_districts",
    description:
      "korter's own district/microdistrict taxonomy for Tbilisi with their average price per m². " +
      "Names are korter's, as-is — their 'Vake district' swallows Bagebi, Lisi and the Nutsubidze plateau.",
    inputSchema: { type: "object", additionalProperties: false },
    execute: () => {
      const rows = deps.districts.list();
      if (rows.length === 0) {
        return Promise.resolve(
          MCPToolResult.failure("No taxonomy observed yet — refresh a listing source first (e.g. listing:new-projects-in-avlabari)."),
        );
      }
      const nowMs = now();
      return Promise.resolve(
        MCPToolResult.success({
          count: rows.length,
          districts: rows.map((d) => ({
            geo_object_id: d.geoObjectId,
            name: d.name,
            category: d.category,
            listing_link: d.link,
            parent_id: d.parentId,
            avg_price_per_m2: d.avgPricePerM2,
            currency: d.currency,
            source_url: d.sourceUrl,
            fetched_at: d.fetchedAt,
            prices_as_of: null,
            observed_at: d.fetchedAt,
            staleness_days: stalenessDays(d.fetchedAt, nowMs),
          })),
        }),
      );
    },
  });

  registry.register({
    name: "price_history",
    description:
      "The accrued price history for one project — every price change and re-dating this tool has " +
      "observed, from the journal. This is the value korter does not show: how the price moved.",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" }, currency: CURRENCY },
      required: ["slug"],
      additionalProperties: false,
    },
    execute: (input) => {
      const { slug, currency } = input as { slug: string; currency?: Currency };
      const entries = priceHistory(deps.reader, slug, currency);
      if (entries.length === 0) {
        return Promise.resolve(MCPToolResult.failure(`No history for "${slug}" — is it tracked and refreshed?`));
      }
      return Promise.resolve(MCPToolResult.success({ slug, count: entries.length, history: entries }));
    },
  });

  registry.register({
    name: "diff_report",
    description:
      "What changed across all observed projects since a timestamp: price moves (old → new), " +
      "newly discovered projects, delistings, and listing membership changes.",
    inputSchema: {
      type: "object",
      properties: { since: { type: "string", description: "ISO date or datetime, e.g. 2026-08-01" } },
      required: ["since"],
      additionalProperties: false,
    },
    execute: (input) => {
      const { since } = input as { since: string };
      const sinceMs = Date.parse(since);
      if (Number.isNaN(sinceMs)) {
        return Promise.resolve(MCPToolResult.failure(`Cannot parse "${since}" as a date.`));
      }
      return Promise.resolve(MCPToolResult.success(diffReport(deps.reader, sinceMs)));
    },
  });

  registry.register({
    name: "refresh",
    description:
      "Fetch one source from korter now (cache-first, 24h TTL; globally paced at 1 req/s; honest UA). " +
      "source_id is 'project:<slug>' or 'listing:<slug>'. If korter answers 403/429 the circuit breaker " +
      "opens and stays open — by design this tool stops instead of evading.",
    inputSchema: {
      type: "object",
      properties: {
        source_id: { type: "string", description: "e.g. project:tsavkisi-park-tbilisi" },
        force: { type: "boolean", default: false, description: "bypass the 24h page cache" },
      },
      required: ["source_id"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const { source_id, force } = input as { source_id: string; force?: boolean };
      if (parseSourceId(source_id) === null) {
        return MCPToolResult.failure(`Invalid source_id "${source_id}" — expected listing:<slug> or project:<slug>.`);
      }
      const asked = await deps.runtime.ask(source_id as EntityId, { tag: "Refresh", force: force === true }, sourceCategory);
      if (!asked.ok) return MCPToolResult.failure(`refresh failed: ${JSON.stringify(asked.error)}`);
      const reply = asked.value.reply;
      if (reply?.tag !== "Done") return MCPToolResult.failure("refresh returned no outcome");
      return refreshOutcomeResult(source_id, reply.outcome, deps);
    },
  });

  registry.register({
    name: "track",
    description:
      "Add a source to the weekly sweep (journaled; survives restarts). Seed set: " +
      SEED_SOURCES.join(", "),
    inputSchema: {
      type: "object",
      properties: { source_id: { type: "string" } },
      required: ["source_id"],
      additionalProperties: false,
    },
    execute: (input) => askTracker(deps, { tag: "Track", sourceId: (input as { source_id: string }).source_id }),
  });

  registry.register({
    name: "untrack",
    description: "Remove a source from the weekly sweep.",
    inputSchema: {
      type: "object",
      properties: { source_id: { type: "string" } },
      required: ["source_id"],
      additionalProperties: false,
    },
    execute: (input) => askTracker(deps, { tag: "Untrack", sourceId: (input as { source_id: string }).source_id }),
  });

  registry.register({
    name: "list_tracked",
    description: "The sources in the weekly sweep, and when the last sweep ran.",
    inputSchema: { type: "object", additionalProperties: false },
    execute: async () => {
      const asked = await deps.runtime.ask(TRACKER_ID as EntityId, { tag: "GetTracked" }, trackerCategory);
      if (!asked.ok) return MCPToolResult.failure(`tracker unavailable: ${JSON.stringify(asked.error)}`);
      const reply = asked.value.reply;
      if (reply?.tag !== "Tracked") return MCPToolResult.failure("unexpected tracker reply");
      return MCPToolResult.success({ tracked: reply.sourceIds, last_sweep_at: reply.lastSweepAt });
    },
  });

  registry.register({
    name: "search_secondary",
    description:
      "Search the secondary market (resale and rent) from the latest snapshots of tracked secondary " +
      "sources. Each result links to the korter listing — contact with the seller happens THERE; this " +
      "server stores property facts only, never seller identities. Per-listing korter freshness is in " +
      "actualize_staleness_days. If a district has no snapshot, the result says which source to refresh.",
    inputSchema: {
      type: "object",
      properties: {
        section: { type: "string", enum: ["sale", "rent"], default: "sale", description: "sale prices are totals; rent is per month" },
        district: { type: "string" },
        city: { type: "string" },
        rooms: { type: "number" },
        min_rooms: { type: "number" },
        min_area_m2: { type: "number" },
        max_area_m2: { type: "number" },
        max_price: { type: "number", description: "total for sale, monthly for rent" },
        max_price_per_m2: { type: "number" },
        property_type: { type: "string", description: "e.g. flat, studio" },
        include_unavailable: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
    execute: (input) => {
      const a = input as Record<string, unknown> & { section?: "sale" | "rent" };
      const section = a.section ?? "sale";
      const nowMs = now();
      const eq = (x: string | null, y: unknown): boolean =>
        typeof y !== "string" || (x !== null && x.toLowerCase() === y.toLowerCase());
      const lte = (x: number | null, y: unknown): boolean => typeof y !== "number" || (x !== null && x <= y);
      const gte = (x: number | null, y: unknown): boolean => typeof y !== "number" || (x !== null && x >= y);

      const rows = deps.secondary.listings().filter((r) => {
        if (r.section !== section) return false;
        if (a["include_unavailable"] !== true && r.availableStatus !== null && r.availableStatus !== "available") return false;
        if (!eq(r.district, a["district"])) return false;
        if (!eq(r.city, a["city"])) return false;
        if (typeof a["rooms"] === "number" && r.roomCount !== a["rooms"]) return false;
        if (!gte(r.roomCount, a["min_rooms"])) return false;
        if (!gte(r.areaM2, a["min_area_m2"])) return false;
        if (!lte(r.areaM2, a["max_area_m2"])) return false;
        if (!lte(r.price, a["max_price"])) return false;
        if (!lte(r.pricePerM2, a["max_price_per_m2"])) return false;
        if (!eq(r.propertyType, a["property_type"])) return false;
        return true;
      });

      const result: Record<string, unknown> = {
        section,
        count: rows.length,
        listings: rows.slice(0, 50).map((r) => secondaryResult(r, nowMs)),
      };
      if (rows.length === 0) {
        const known = deps.secondary.sources();
        const stats = deps.secondary.districtStats();
        const wanted = typeof a["district"] === "string" ? (a["district"] as string) : null;
        const stat = wanted ? stats.find((s) => s.name.toLowerCase() === wanted.toLowerCase()) : null;
        const link = stat ? (section === "rent" ? stat.rentLink : stat.saleLink) : null;
        result["hint"] =
          known.length === 0
            ? "No secondary snapshots yet — an operator needs to refresh a secondary source first."
            : `No snapshot covers this filter. Snapshots: ${known.map((k) => `${k.sourceId} (${k.count})`).join(", ")}.` +
              (link ? ` For ${wanted} ${section}, the source is secondary:${link.replace(/^\/en\//, "")}.` : "");
      }
      return Promise.resolve(MCPToolResult.success(result));
    },
  });

  registry.register({
    name: "secondary_trends",
    description:
      "Secondary-market aggregates per district (korter's own figures: avg price/m², sale and rent " +
      "ranges) plus the accrued trend from the journal for tracked secondary sources.",
    inputSchema: {
      type: "object",
      properties: { district: { type: "string" } },
      additionalProperties: false,
    },
    execute: (input) => {
      const { district } = input as { district?: string };
      const nowMs = now();
      // korter writes the focus district as "Vake District" while cards and
      // users say "Vake" — compare normalized.
      const norm = (s: string): string => s.toLowerCase().replace(/\s+district$/, "");
      let stats = deps.secondary.districtStats();
      if (district) stats = stats.filter((s) => norm(s.name) === norm(district));

      const trendEvents = deps.reader
        .queryEvents({ category: "source", order: "asc", limit: 1000 })
        .filter((r) => r.manifest === "SecondaryMarketObserved")
        .map((r) => {
          const e = r.payload as { stats: SecondaryStats; observedAt: string };
          return {
            source: r.entityId,
            observed_at: e.observedAt,
            ...e.stats,
            sample_median_price_per_m2: e.stats.sampleMedianPriceSqm ?? null,
          };
        })
        .filter((t) => !district || (t.district !== null && norm(t.district) === norm(district)));

      return Promise.resolve(
        MCPToolResult.success({
          districts: stats.map((s) => ({
            name: s.name,
            avg_price_per_m2: s.avgPriceSqm,
            sale_price_range: [s.salePriceMin, s.salePriceMax],
            rent_monthly_range: [s.rentMin, s.rentMax],
            currency: s.currency,
            fetched_at: s.fetchedAt,
            staleness_days: stalenessDays(s.fetchedAt, nowMs),
          })),
          trend: trendEvents,
        }),
      );
    },
  });

  registry.register({
    name: "consent",
    description:
      "Record or change YOUR consent (authenticated users). Two separate consents: accept_terms — " +
      "required to use the tools (notice: get_skill 'privacy'); marketing_offers — OPTIONAL opt-in to " +
      "receive real-estate suggestions matching your searches, never required. Omit a field to leave it " +
      "unchanged; false revokes.",
    inputSchema: {
      type: "object",
      properties: {
        accept_terms: { type: "boolean" },
        marketing_offers: { type: "boolean" },
      },
      additionalProperties: false,
    },
    execute: async (input) => {
      const id = currentIdentity();
      if (!id || id.operator) {
        return MCPToolResult.failure("No end-user identity in this context — consent applies to authenticated users on the hosted endpoint.");
      }
      const { accept_terms, marketing_offers } = input as { accept_terms?: boolean; marketing_offers?: boolean };
      const at = new Date(now()).toISOString();
      await touchUser(deps, id, at);
      for (const [kind, value] of [["terms", accept_terms], ["marketing", marketing_offers]] as const) {
        if (value === true) {
          await deps.runtime.ask(id.sub as EntityId, { tag: "GrantConsent", kind, textVersion: PRIVACY_VERSION, at }, userCategory);
        } else if (value === false) {
          await deps.runtime.ask(id.sub as EntityId, { tag: "RevokeConsent", kind, at }, userCategory);
        }
      }
      const profile = await userProfile(deps, id.sub);
      return MCPToolResult.success({
        recorded: true,
        notice_version: PRIVACY_VERSION,
        terms_accepted: profile ? hasTermsConsent(profile) : false,
        marketing_offers: profile?.consents["marketing"] != null,
        note: "Revoke any time by calling consent with the field set to false. Full notice: get_skill 'privacy'.",
      });
    },
  });

  registry.register({
    name: "my_data",
    description:
      "Everything this server holds about YOU (authenticated users): profile, consent log, recorded " +
      "search interests. Your right to know — and the map for what consent(false) erases from use.",
    inputSchema: { type: "object", additionalProperties: false },
    execute: async () => {
      const id = currentIdentity();
      if (!id || id.operator) {
        return MCPToolResult.failure("No end-user identity in this context.");
      }
      const profile = await userProfile(deps, id.sub);
      const events = deps.reader
        .queryEvents({ category: "user", entityId: id.sub, order: "asc", limit: 1000 })
        .map((r) => r.payload as UserEvent); // every event carries its own `at`
      return MCPToolResult.success({
        subject: id.sub,
        email: profile?.email ?? id.email,
        name: profile?.name ?? id.name,
        terms_accepted_version: profile?.consents["terms"]?.textVersion ?? null,
        marketing_offers: profile?.consents["marketing"] != null,
        consent_and_interest_log: events,
        note: "Interests are recorded only from your own consented searches; sellers' identities are never stored by this service.",
      });
    },
  });

  registry.register({
    name: "list_users",
    description: "Operator only: registered users, their consents and interest profiles (the opted-in list is the offers feed).",
    inputSchema: { type: "object", additionalProperties: false },
    execute: () => {
      const rows = deps.reader.queryEvents({ category: "user", order: "asc", limit: 1000 });
      const users = new Map<string, Record<string, unknown> & { interests: unknown[] }>();
      for (const r of rows) {
        const e = r.payload as UserEvent;
        const u = users.get(r.entityId) ?? { subject: r.entityId, email: null, name: null, terms: null, marketing: false, interests: [] };
        switch (e.tag) {
          case "UserRegistered":
          case "ProfileObserved":
            if (e.email) u["email"] = e.email;
            if (e.name) u["name"] = e.name;
            break;
          case "ConsentGranted":
            if (e.kind === "terms") u["terms"] = e.textVersion;
            else u["marketing"] = true;
            break;
          case "ConsentRevoked":
            if (e.kind === "terms") u["terms"] = null;
            else u["marketing"] = false;
            break;
          case "InterestObserved": {
            const { tag, ...interest } = e;
            u.interests.push(interest);
            if (u.interests.length > 10) u.interests.shift();
            break;
          }
        }
        users.set(r.entityId, u);
      }
      return Promise.resolve(MCPToolResult.success({ count: users.size, users: [...users.values()] }));
    },
  });

  // ---------------------------------------------------------------------
  // Access tiers + consented interest tracking, applied over every tool.
  // register() overwrites by name, so one pass wraps the lot.
  // ---------------------------------------------------------------------
  for (const tool of registry.list()) {
    registry.register(wrapWithTier(tool, deps, () => now()));
  }
}

function secondaryResult(r: SecondaryRow, nowMs: number): Record<string, unknown> {
  return {
    korter_url: `${KORTER_ORIGIN}${r.link}`,
    section: r.section,
    building: r.buildingName,
    project_slug: r.buildingSlug,
    address: r.address,
    district: r.district,
    city: r.city,
    price: r.price,
    currency: r.currency + (r.section === "rent" ? "/month" : ""),
    area_m2: r.areaM2,
    price_per_m2: r.pricePerM2,
    rooms: r.roomCount,
    property_type: r.propertyType,
    floor: r.floor !== null && r.floorCount !== null ? `${r.floor}/${r.floorCount}` : r.floor,
    // korter's own per-listing actualization date — their freshness, surfaced.
    actualized_at: r.actualizeTime,
    actualize_staleness_days: stalenessDays(r.actualizeTime, nowMs),
    fetched_at: r.fetchedAt,
    source_url: r.sourceUrl,
  };
}

const CONSENT_REQUIRED =
  "Consent required before using this tool. Read the notice (get_skill with name 'privacy'), then call " +
  "the consent tool: accept_terms=true to use the service, and optionally marketing_offers=true if you " +
  "want real-estate suggestions matching your searches (never required).";

function wrapWithTier(tool: MCPTool, deps: ToolDeps, nowMs: () => number): MCPTool {
  const tier = TIERS[tool.name] ?? "operator"; // unknown tools fail closed
  const interestOf = INTEREST_OF[tool.name];
  return {
    ...tool,
    execute: async (input): Promise<MCPToolResultValue> => {
      const id = currentIdentity();
      // Local stdio (no identity) and the operator are ungated and untracked.
      if (id === null || id.operator) return tool.execute(input);

      if (tier === "command") {
        return MCPToolResult.failure(
          "Operator-only: this deployment fetches korter on its own paced schedule; searches are served " +
            "from already-collected data. Ask the operator if a district you need is missing.",
        );
      }
      if (tier === "operator") {
        return MCPToolResult.failure("Operator-only tool.");
      }

      const at = new Date(nowMs()).toISOString();
      if (tier === "read") {
        await touchUser(deps, id, at);
        const profile = await userProfile(deps, id.sub);
        if (!profile || !hasTermsConsent(profile)) {
          return MCPToolResult.failure(CONSENT_REQUIRED);
        }
        if (interestOf) {
          const interest = interestOf((input ?? {}) as Record<string, unknown>);
          await deps.runtime.tell(id.sub as EntityId, { tag: "ObserveInterest", interest, at }, userCategory);
        }
      }
      return tool.execute(input);
    },
  };
}

async function touchUser(deps: ToolDeps, id: Identity, at: string): Promise<void> {
  await deps.runtime.ask(
    id.sub as EntityId,
    {
      tag: "Touch",
      ...(id.email ? { email: id.email } : {}),
      ...(id.name ? { name: id.name } : {}),
      ...(id.provider ? { provider: id.provider } : {}),
      at,
    },
    userCategory,
  );
}

async function userProfile(deps: ToolDeps, sub: string): Promise<UserState | null> {
  const asked = await deps.runtime.ask(sub as EntityId, { tag: "GetProfile" }, userCategory);
  if (!asked.ok) return null;
  const reply: UserReply | undefined = asked.value.reply;
  return reply?.tag === "Profile" ? reply.state : null;
}

async function askTracker(
  deps: ToolDeps,
  command: { tag: "Track" | "Untrack"; sourceId: string },
): Promise<MCPToolResultValue> {
  const asked = await deps.runtime.ask(TRACKER_ID as EntityId, command, trackerCategory);
  if (!asked.ok) return MCPToolResult.failure(`tracker unavailable: ${JSON.stringify(asked.error)}`);
  const reply: TrackerReply | undefined = asked.value.reply;
  if (reply?.tag === "Rejected") return MCPToolResult.failure(reply.reason);
  return MCPToolResult.success({ ok: true, source_id: command.sourceId });
}

function refreshOutcomeResult(sourceId: string, outcome: RefreshOutcome, deps: ToolDeps): MCPToolResultValue {
  switch (outcome.tag) {
    case "Fetched":
      deps.refreshProjections();
      return MCPToolResult.success({
        source_id: sourceId,
        result: "fetched",
        fetched_at: outcome.fetchedAt,
        from_cache: outcome.fromCache,
        projects_observed: outcome.projects,
      });
    case "Unchanged":
      return MCPToolResult.success({ source_id: sourceId, result: "unchanged", fetched_at: outcome.fetchedAt });
    case "ParseFailed":
      return MCPToolResult.failure(
        `korter's page layout changed — parse failed: ${outcome.reason}. The fetch was fine; the extractor needs updating.`,
      );
    case "Failed":
      switch (outcome.kind) {
        case "blocked":
        case "ratelimited":
        case "breaker":
          return MCPToolResult.failure(
            "korter is rate-limiting or blocking; the circuit breaker is open. By design this tool stops " +
              "instead of evading — try again much later. " + outcome.detail,
          );
        case "gone":
          return MCPToolResult.failure(`korter returns 404 for ${sourceId} — recorded as gone/delisted.`);
        case "robots":
          return MCPToolResult.failure(outcome.detail);
        default:
          return MCPToolResult.failure(`fetch failed (transient): ${outcome.detail}. Safe to retry later.`);
      }
  }
}

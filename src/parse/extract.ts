/**
 * Pure extraction: (html) => PageObservation. The only fragile code in the
 * repo — everything else depends on the types in ./types.js, never on korter's
 * page internals. Paths documented in docs/schema-notes.md; change them there
 * first.
 *
 * korter inlines the full render state as `window.INITIAL_STATE = {...};`.
 * No network, no DOM — a balanced-brace scan and JSON.parse.
 */
import {
  type Currency,
  type DistrictAvgPrice,
  type GeoObjectNode,
  type ListingPage,
  type PageObservation,
  type ProjectObservation,
  type ProjectPage,
  type SecondaryDistrictAggregate,
  type SecondaryListing,
  type SecondaryPage,
  type UnitTypeObservation,
  ParseError,
} from "./types.js";

const STATE_MARKER = "window.INITIAL_STATE = ";

export function extractPage(html: string): PageObservation {
  const state = extractInitialState(html);
  const slug = pageSlug(state);
  const currency = pageCurrency(state);

  const listing = obj(state["buildingListingStore"]);
  if (listing) return extractListing(listing, slug, currency);

  const landing = obj(state["buildingLandingStore"]);
  if (landing) return extractProject(landing, slug, currency);

  const secondary = obj(state["apartmentListingStore"]);
  if (secondary) return extractSecondary(secondary, slug, currency);

  throw new ParseError(
    "no buildingListingStore/buildingLandingStore/apartmentListingStore — page layout changed or this is not a supported page",
  );
}

/** Exposed for tests and for the diff on re-fetch: the raw embedded state. */
export function extractInitialState(html: string): Record<string, unknown> {
  const at = html.indexOf(STATE_MARKER);
  if (at < 0) throw new ParseError("window.INITIAL_STATE not found");
  const start = html.indexOf("{", at + STATE_MARKER.length);
  if (start < 0) throw new ParseError("no object literal after INITIAL_STATE marker");
  const raw = balancedJson(html, start);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ParseError(`INITIAL_STATE is not valid JSON: ${(e as Error).message}`);
  }
  const state = obj(parsed);
  if (!state) throw new ParseError("INITIAL_STATE is not an object");
  return state;
}

/** Scan a balanced {...} respecting JSON string escapes. */
function balancedJson(text: string, start: number): string {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new ParseError("unterminated INITIAL_STATE object");
}

function pageSlug(state: Record<string, unknown>): string {
  const seo = obj(state["seoStore"]);
  const original = str(seo?.["originalUrl"]);
  const canonical = str(seo?.["canonicalLink"]);
  const path = original ?? (canonical ? new URL(canonical).pathname : null);
  const slug = path?.replace(/^\/(en|ka|ru)\//, "").replace(/\/+$/, "");
  if (!slug) throw new ParseError("seoStore.originalUrl/canonicalLink missing — cannot determine page slug");
  return slug;
}

function pageCurrency(state: Record<string, unknown>): Currency {
  const cur = str(obj(state["currencyStore"])?.["currency"]);
  if (cur === "USD" || cur === "GEL") return cur;
  throw new ParseError(`currencyStore.currency is ${JSON.stringify(cur)}, expected USD or GEL`);
}

function extractListing(store: Record<string, unknown>, slug: string, currency: Currency): ListingPage {
  const buildings = arr(store["buildings"]);
  if (!buildings) throw new ParseError("buildingListingStore.buildings missing");

  const projects = buildings.flatMap((b): ProjectObservation[] => {
    const card = obj(b);
    if (!card) return [];
    const cardSlug = slugFromPath(str(card["url"]));
    if (!cardSlug) return []; // a card we cannot address is a card we skip
    return [
      {
        slug: cardSlug,
        korterId: num(card["buildingId"]),
        name: str(card["name"]),
        address: str(card["address"]),
        district: str(card["subLocalityNominative"]),
        city: str(obj(card["mainGeoObject"])?.["name"]),
        developer: firstDeveloperName(card["developers"]),
        lat: num(obj(card["location"])?.["lat"]),
        lng: num(obj(card["location"])?.["lng"]),
        constructionStatus: str(card["constructionStatus"]),
        salesStatus: str(card["salesStatus"]),
        buildingType: null, // not on listing cards
        priceFrom: price(card["minPrice"]),
        pricePerM2: price(card["minPriceSqm"]),
        pricesAsOf: null, // listing cards never carry pricesUpdateTime
        unitTypes: null, // listing cards carry no per-unit breakdown
        renovation: null,
        isDeleted: false,
      },
    ];
  });

  const filters = obj(store["filtersStore"]);
  return {
    pageType: "listing",
    slug,
    currency,
    projects,
    taxonomy: geoNode(obj(filters?.["geoObjects"])?.["mainGeoObject"], obj(filters?.["geoObjects"])?.["childrenGeoObjects"]),
    districtAvgPrices: avgPrices(store["geoObjectsAvgPrices"]),
    totalCount: num(filters?.["totalCount"]),
  };
}

function extractProject(store: Record<string, unknown>, slug: string, currency: Currency): ProjectPage {
  const main = obj(store["main"]);
  if (!main) throw new ParseError("buildingLandingStore.main missing");
  const map = obj(store["map"]);
  const sub = obj(main["subLocality"]);

  const project: ProjectObservation = {
    slug,
    korterId: num(store["buildingId"]),
    name: str(main["name"]) ?? str(main["nameOrAddress"]),
    address: str(main["address"]),
    district: str(sub?.["nominative"]),
    city: str(main["mainGeoObjectNominative"]),
    developer: firstDeveloperName(main["developers"]),
    lat: num(map?.["lat"]),
    lng: num(map?.["lng"]),
    constructionStatus: str(main["constructionStatus"]),
    salesStatus: str(main["salesStatus"]),
    buildingType: str(main["buildingType"]),
    priceFrom: price(main["minPrice"]),
    pricePerM2: price(main["minPriceSqm"]),
    pricesAsOf: str(main["pricesUpdateTime"]),
    unitTypes: unitTypes(obj(store["prices"])?.["unitTypes"]),
    renovation: str(main["renovation"]),
    isDeleted: main["isDeleted"] === true,
  };
  return { pageType: "project", slug, currency, projects: [project] };
}

function extractSecondary(store: Record<string, unknown>, slug: string, currency: Currency): SecondaryPage {
  const cards = arr(store["apartments"]);
  if (!cards) throw new ParseError("apartmentListingStore.apartments missing");
  const sectionFromSlug: "sale" | "rent" = /rent/.test(slug) ? "rent" : "sale";

  const listings = cards.flatMap((c): SecondaryListing[] => {
    const card = obj(c);
    const objectId = num(card?.["objectId"]);
    if (!card || objectId === null) return [];
    // Deliberately NOT read: card.userId (korter's seller account id) — a
    // search tool needs property facts and the korter link, never seller ids.
    const building = obj(card["building"]);
    const house = obj(card["house"]);
    const position = obj(building?.["position"]);
    const price = priceOf(card["price"]);
    const area = num(card["area"]);
    const section = card["section"] === "rent" || card["section"] === "sale" ? (card["section"] as "sale" | "rent") : sectionFromSlug;
    return [
      {
        objectId,
        section,
        link: str(card["link"]) ?? `/en/${slug}`,
        buildingName: str(building?.["name"]),
        buildingSlug: slugFromPath(str(building?.["link"])),
        address: str(card["address"]) ?? str(building?.["address"]),
        district: str(card["subLocalityNominative"]),
        city: str(obj(card["mainGeoObject"])?.["nominative"]),
        price,
        areaM2: area,
        pricePerM2: price !== null && area !== null && area > 0 ? Math.round(price / area) : null,
        roomCount: num(card["roomCount"]),
        propertyType: str(card["propertyType"]) ?? str(card["propertyCategory"]),
        floor: num(arr(card["floorNumbers"])?.[0]),
        floorCount: num(house?.["floorCount"]),
        lat: num(position?.["lat"]),
        lng: num(position?.["lng"]),
        actualizeTime: str(card["actualizeTime"]),
        availableStatus: str(card["availableStatus"]),
      },
    ];
  });

  const filters = obj(store["filtersStore"]);
  const aggregates = (arr(obj(obj(store["geoObjectsAvgPrices"])?.["primaryGeoObjects"])?.["geoObjects"]) ?? []).flatMap(
    (g): SecondaryDistrictAggregate[] => {
      const o = obj(g);
      const id = num(o?.["geoObjectId"]);
      const name = str(o?.["nominative"]);
      if (!o || id === null || name === null) return [];
      return [
        {
          id,
          name,
          avgPriceSqm: priceOf(o["averagePrice"]),
          salePriceMin: priceOf(o["minLayoutsPrice"]),
          salePriceMax: priceOf(o["maxLayoutsPrice"]),
          rentMin: priceOf(o["minLayoutsRentPrice"]),
          rentMax: priceOf(o["maxLayoutsRentPrice"]),
          saleLink: str(o["apartmentListingLink"]),
          rentLink: str(o["apartmentListingRentLink"]),
        },
      ];
    },
  );

  return {
    pageType: "secondary",
    slug,
    currency,
    section: listings[0]?.section ?? sectionFromSlug,
    listings,
    totalCount: num(filters?.["totalCount"]),
    focusDistrictId: num(obj(filters?.["routeParams"])?.["geo_object_id"]),
    focusDistrictName: str(obj(obj(store["geoObjectsAvgPrices"])?.["geoObject"])?.["nominative"]),
    aggregates,
  };
}

function unitTypes(raw: unknown): UnitTypeObservation[] | null {
  const list = arr(raw);
  if (!list) return null;
  return list.flatMap((u): UnitTypeObservation[] => {
    const o = obj(u);
    const name = str(o?.["unitTypeName"]);
    if (!o || !name) return [];
    const priceRange = obj(o["price"]);
    const areaRange = obj(o["area"]);
    return [
      {
        name,
        propertyType: str(o["propertyType"]),
        roomCount: num(o["roomCount"]),
        areaMin: num(areaRange?.["minArea"]),
        areaMax: num(areaRange?.["maxArea"]),
        priceMin: price(priceRange?.["minPrice"]),
        priceMax: price(priceRange?.["maxPrice"]),
        pricePerM2Min: price(o["minPriceSqm"]),
        allSold: o["allSold"] === true,
      },
    ];
  });
}

function geoNode(root: unknown, children: unknown): GeoObjectNode | null {
  const r = obj(root);
  if (!r) return null;
  const id = num(r["geoObjectId"]);
  const name = str(r["nominative"]);
  if (id === null || name === null) return null;
  const kids = (arr(children) ?? arr(r["childrenGeoObjects"]) ?? []).flatMap((c) => {
    const node = geoNode(c, undefined);
    return node ? [node] : [];
  });
  return { id, name, category: str(r["category"]) ?? "unknown", link: str(r["link"]), children: kids };
}

function avgPrices(raw: unknown): DistrictAvgPrice[] {
  const geos = arr(obj(obj(raw)?.["primaryGeoObjects"])?.["geoObjects"]) ?? [];
  return geos.flatMap((g) => {
    const o = obj(g);
    const id = num(o?.["geoObjectId"]);
    const name = str(o?.["nominative"]);
    if (!o || id === null || name === null) return [];
    return [{ id, name, averagePrice: price(o["averagePrice"]), link: str(o["buildingListingLink"]) }];
  });
}

function firstDeveloperName(raw: unknown): string | null {
  const first = obj(arr(raw)?.[0]);
  return str(first?.["name"]);
}

function slugFromPath(path: string | null): string | null {
  if (!path) return null;
  const m = /^\/(?:en|ka|ru)\/([^/?#]+)/.exec(path);
  return m ? m[1] : null;
}

/** korter uses 0 for "price not shown"; a zero price is never a price. */
const priceOf = (v: unknown): number | null => price(v);
function price(v: unknown): number | null {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function arr(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

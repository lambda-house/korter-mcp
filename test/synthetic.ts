/**
 * Synthetic korter-shaped pages: invented data rendered into the exact
 * window.INITIAL_STATE structure documented in docs/schema-notes.md.
 *
 * Why this exists: the real fixtures/ are verbatim korter.ge pages and never
 * leave the internal repo (republishing them is korter's copyright and our own
 * hard rule 3). Every test that exercises OUR machinery — aggregates, fetch
 * lifecycle, projections, tools — runs against these synthetic pages, so the
 * public snapshot's test suite is complete without a byte of korter content.
 * Only the parser-compatibility tests (extract.test.ts and friends) read real
 * fixtures, and they skip when the files are absent.
 */
import type { Currency } from "../src/parse/types.js";

export interface SynthCard {
  slug: string;
  buildingId: number;
  name: string;
  address?: string | null;
  district: string;
  city?: string;
  developer?: string | null;
  lat?: number;
  lng?: number;
  constructionStatus?: string;
  salesStatus?: string;
  minPrice: number | null;
  minPriceSqm: number | null;
}

export interface SynthGeoNode {
  id: number;
  name: string;
  category: string;
  link?: string | null;
  children?: SynthGeoNode[];
}

export interface SynthListingSpec {
  slug: string;
  currency?: Currency;
  cards: SynthCard[];
  taxonomy?: { root: SynthGeoNode; children: SynthGeoNode[] };
  avgPrices?: { id: number; name: string; averagePrice: number | null; link?: string | null }[];
}

export interface SynthUnit {
  name: string;
  propertyType?: string;
  roomCount: number | null;
  areaMin: number | null;
  areaMax: number | null;
  priceMin: number | null;
  priceMax: number | null;
  minPriceSqm?: number | null;
  allSold?: boolean;
}

export interface SynthProjectSpec {
  slug: string;
  buildingId: number;
  name: string;
  currency?: Currency;
  address?: string | null;
  district?: { id: number; name: string };
  city?: string;
  developer?: string | null;
  lat?: number;
  lng?: number;
  constructionStatus?: string;
  salesStatus?: string;
  buildingType?: string;
  renovation?: string | null;
  minPrice: number | null;
  minPriceSqm: number | null;
  pricesUpdateTime?: string | null;
  units?: SynthUnit[];
  isDeleted?: boolean;
}

export const SYNTHETIC_ROBOTS = ["User-agent: *", "Disallow: /redirect", "Disallow: /api/", ""].join("\n");

function page(state: Record<string, unknown>): string {
  return [
    "<!doctype html><html><head><title>synthetic</title></head><body>",
    `<script>window.serverUrl = "building/geo"; window.INITIAL_STATE = ${JSON.stringify(state)};</script>`,
    "</body></html>",
  ].join("\n");
}

function baseStores(slug: string, currency: Currency): Record<string, unknown> {
  return {
    userStore: { user: { userId: null } },
    seoStore: { originalUrl: `/en/${slug}`, canonicalLink: `https://korter.example/en/${slug}` },
    currencyStore: { rate: 2.6, inverseRate: 0.3846, currency, areaUnit: "m" },
  };
}

function geoNode(n: SynthGeoNode): Record<string, unknown> {
  return {
    geoObjectId: n.id,
    nominative: n.name,
    genitive: n.name,
    preposition: n.name,
    category: n.category,
    isExist: true,
    link: n.link ?? `/en/new-projects-${n.name.toLowerCase().replace(/\s+/g, "-")}`,
    childrenGeoObjects: (n.children ?? []).map(geoNode),
  };
}

export function syntheticListingPage(spec: SynthListingSpec): string {
  const currency = spec.currency ?? "USD";
  const state = {
    ...baseStores(spec.slug, currency),
    buildingListingStore: {
      buildings: spec.cards.map((c) => ({
        buildingId: c.buildingId,
        url: `/en/${c.slug}`,
        images: [],
        name: c.name,
        address: c.address ?? `${c.name} street 1`,
        mainGeoObject: { id: 1, name: c.city ?? "Testburg" },
        subLocalityNominative: c.district,
        minPriceSqm: c.minPriceSqm ?? 0,
        minPrice: c.minPrice ?? 0,
        status: "plain",
        salesStatus: c.salesStatus ?? "available",
        developers: c.developer === null ? [] : [{ developerId: 9000 + c.buildingId, name: c.developer ?? "Acme Build", link: "/en/acme" }],
        labels: [],
        location: { lat: c.lat ?? 41.7, lng: c.lng ?? 44.8 },
        constructionStatus: c.constructionStatus ?? "construction",
        phone: "000",
      })),
      filtersStore: {
        totalCount: spec.cards.length,
        geoObjects: spec.taxonomy
          ? { mainGeoObject: geoNode(spec.taxonomy.root), childrenGeoObjects: spec.taxonomy.children.map(geoNode) }
          : { mainGeoObject: null, childrenGeoObjects: [] },
      },
      geoObjectsAvgPrices: spec.avgPrices
        ? {
            geoObject: { category: "district" },
            primaryGeoObjects: {
              category: "district",
              geoObjects: spec.avgPrices.map((a) => ({
                geoObjectId: a.id,
                nominative: a.name,
                averagePrice: a.averagePrice,
                buildingListingLink: a.link ?? `/en/new-projects-${a.name.toLowerCase()}`,
              })),
            },
          }
        : {},
      pagination: { page: { start: 1 }, itemsPerPage: 20 },
    },
  };
  return page(state);
}

export function syntheticProjectPage(spec: SynthProjectSpec): string {
  const currency = spec.currency ?? "USD";
  const state = {
    ...baseStores(spec.slug, currency),
    buildingLandingStore: {
      buildingId: spec.buildingId,
      main: {
        name: spec.name,
        nameOrAddress: spec.name,
        salesStatus: spec.salesStatus ?? "available",
        minPrice: spec.minPrice ?? 0,
        minPriceSqm: spec.minPriceSqm ?? 0,
        prevMinPriceSqm: spec.minPriceSqm ?? 0,
        pricesUpdateTime: spec.pricesUpdateTime === undefined ? "2026-08-01T00:00:00+00:00" : spec.pricesUpdateTime,
        developers: spec.developer === null ? [] : [{ developer_id: 8000 + spec.buildingId, name: spec.developer ?? "Acme Build", link: "/en/acme" }],
        address: spec.address ?? null,
        currency: currency === "USD" ? "$" : "₾",
        mainGeoObjectNominative: spec.city ?? "Testburg",
        subLocality: spec.district
          ? { geoObjectId: spec.district.id, nominative: spec.district.name, buildingListingLink: `/en/new-projects-${spec.district.name.toLowerCase()}` }
          : null,
        isDeleted: spec.isDeleted ?? false,
        buildingType: spec.buildingType ?? "apartment",
        constructionStatus: spec.constructionStatus ?? "construction",
        renovation: spec.renovation ?? null,
      },
      map: { lat: spec.lat ?? 41.71, lng: spec.lng ?? 44.79, houses: [] },
      prices: {
        pricesVisible: true,
        unitTypes: (spec.units ?? []).map((u) => ({
          unitTypeName: u.name,
          unitTypeType: "Flat",
          propertyType: u.propertyType ?? "flat",
          hasLayouts: true,
          allSold: u.allSold ?? false,
          price: { minPrice: u.priceMin ?? 0, maxPrice: u.priceMax ?? 0 },
          area: { minArea: u.areaMin, maxArea: u.areaMax },
          minPriceSqm: u.minPriceSqm ?? 0,
          roomCount: u.roomCount,
        })),
      },
      attributes: { house: [], flat: [] },
      gallery: { images: [] },
    },
  };
  return page(state);
}

export interface SynthSecondaryCard {
  objectId: number;
  price: number | null;
  area: number | null;
  roomCount: number | null;
  district: string;
  propertyType?: string;
  city?: string;
  buildingName?: string;
  buildingSlug?: string;
  address?: string;
  floor?: number;
  floorCount?: number;
  actualizeTime?: string;
  availableStatus?: string;
}

export interface SynthSecondarySpec {
  slug: string;
  currency?: Currency;
  section: "sale" | "rent";
  cards: SynthSecondaryCard[];
  focusDistrictId?: number;
  totalCount?: number;
  aggregates?: {
    id: number;
    name: string;
    avg: number | null;
    saleMin?: number | null;
    saleMax?: number | null;
    rentMin?: number | null;
    rentMax?: number | null;
  }[];
}

export function syntheticSecondaryPage(spec: SynthSecondarySpec): string {
  const currency = spec.currency ?? "USD";
  const state = {
    ...baseStores(spec.slug, currency),
    apartmentListingStore: {
      apartments: spec.cards.map((c) => ({
        objectId: c.objectId,
        // Deliberately present in the synthetic data: the parser MUST drop it.
        userId: 900000 + c.objectId,
        price: c.price ?? 0,
        currency,
        area: c.area,
        link: `/en/apartments-for-${spec.section === "rent" ? "rent" : "sale"}-testburg/${c.objectId}`,
        section: spec.section,
        building: {
          buildingId: 5000 + c.objectId,
          name: c.buildingName ?? null,
          address: c.address ?? "Somewhere 1",
          link: c.buildingSlug ? `/en/${c.buildingSlug}` : null,
          position: { lat: 41.7, lng: 44.8 },
        },
        actualizeTime: c.actualizeTime ?? "2026-08-28T00:00:00+00:00",
        roomCount: c.roomCount,
        propertyCategory: "flat",
        propertyType: c.propertyType ?? "flat",
        address: c.address ?? "Somewhere 1",
        subLocalityNominative: c.district,
        house: { floorCount: c.floorCount ?? 10, houseId: 1 },
        floorNumbers: c.floor !== undefined ? [c.floor] : [],
        mainGeoObject: { geoObjectId: 1, nominative: c.city ?? "Testburg" },
        availableStatus: c.availableStatus ?? "available",
      })),
      filtersStore: {
        totalCount: spec.totalCount ?? spec.cards.length,
        routeParams: { geo_object_id: spec.focusDistrictId ?? null },
      },
      geoObjectsAvgPrices: spec.aggregates
        ? {
            geoObject: {
              category: "district",
              nominative: `${spec.cards[0]?.district ?? "Somewhere"} District`,
            },
            primaryGeoObjects: {
              category: "district",
              geoObjects: spec.aggregates.map((a) => ({
                geoObjectId: a.id,
                nominative: a.name,
                averagePrice: a.avg,
                minLayoutsPrice: a.saleMin ?? null,
                maxLayoutsPrice: a.saleMax ?? null,
                minLayoutsRentPrice: a.rentMin ?? null,
                maxLayoutsRentPrice: a.rentMax ?? null,
                apartmentListingLink: `/en/apartments-sale-testburg-${a.name.toLowerCase().replace(/\s+/g, "-")}-district`,
                apartmentListingRentLink: `/en/apartments-for-rent-testburg-${a.name.toLowerCase().replace(/\s+/g, "-")}`,
              })),
            },
          }
        : {},
      groupedRealtyCount: spec.totalCount ?? spec.cards.length,
      pagination: { page: { start: 1 }, itemsPerPage: 20 },
    },
  };
  return page(state);
}

// ---------------------------------------------------------------------------
// The canonical invented dataset shared by the suite. Everything below is
// fiction: Testburg city, Riverside/Old Mill/Hillcrest districts, Acme Build.
// ---------------------------------------------------------------------------

export const RIVERSIDE_SALE: SynthSecondarySpec = {
  slug: "apartments-sale-testburg-riverside-district",
  section: "sale",
  focusDistrictId: 10,
  totalCount: 240,
  cards: [
    { objectId: 1, price: 215000, area: 78, roomCount: 3, district: "Riverside", buildingName: "River Towers", buildingSlug: "river-towers-testburg", floor: 20, floorCount: 26 },
    { objectId: 2, price: 96000, area: 48, roomCount: 2, district: "Riverside", floor: 3, floorCount: 9 },
    { objectId: 3, price: 350000, area: 140, roomCount: 4, district: "Riverside", floor: 7, floorCount: 12, availableStatus: "sold" },
    { objectId: 4, price: 128000, area: 64, roomCount: 2, district: "Riverside", propertyType: "studio", floor: 5, floorCount: 16 },
  ],
  aggregates: [
    { id: 10, name: "Riverside", avg: 2100, saleMin: 60000, saleMax: 900000, rentMin: 400, rentMax: 4000 },
    { id: 11, name: "Old Mill", avg: 1700, saleMin: 45000, saleMax: 500000, rentMin: 300, rentMax: 2500 },
  ],
};

export const RIVERSIDE_RENT: SynthSecondarySpec = {
  slug: "apartments-for-rent-testburg-riverside",
  section: "rent",
  focusDistrictId: 10,
  totalCount: 95,
  cards: [
    { objectId: 11, price: 1200, area: 65, roomCount: 2, district: "Riverside", floor: 4, floorCount: 10 },
    { objectId: 12, price: 2600, area: 130, roomCount: 3, district: "Riverside", floor: 9, floorCount: 14 },
  ],
  aggregates: [{ id: 10, name: "Riverside", avg: 2100, rentMin: 400, rentMax: 4000 }],
};

export const RIVERSIDE_CARD: SynthCard = {
  slug: "river-towers-testburg",
  buildingId: 101,
  name: "River Towers",
  address: "Quay 7",
  district: "Riverside",
  developer: "Acme Build",
  lat: 41.701,
  lng: 44.801,
  constructionStatus: "construction",
  salesStatus: "available",
  minPrice: 150000,
  minPriceSqm: 2800,
};

export const TESTBURG_LISTING: SynthListingSpec = {
  slug: "new-projects-in-riverside",
  cards: [
    RIVERSIDE_CARD,
    ...Array.from({ length: 10 }, (_, i): SynthCard => {
      const n = i + 2;
      return {
        slug: `riverside-block-${n}-testburg`,
        buildingId: 100 + n,
        name: `Riverside Block ${n}`,
        district: "Riverside",
        minPrice: 60000 + n * 10000,
        minPriceSqm: 1000 + n * 150,
        constructionStatus: n % 3 === 0 ? "ready" : "construction",
      };
    }),
  ],
  taxonomy: {
    root: { id: 1, name: "Testburg", category: "city" },
    children: [
      { id: 10, name: "Riverside", category: "district", children: [{ id: 101, name: "Quayside", category: "microdistrict" }] },
      { id: 11, name: "Old Mill", category: "district" },
      { id: 12, name: "Hillcrest", category: "district" },
      ...Array.from({ length: 9 }, (_, i) => ({ id: 20 + i, name: `District ${i + 1}`, category: "district" })),
    ],
  },
  avgPrices: [
    { id: 10, name: "Riverside", averagePrice: 1381 },
    { id: 11, name: "Old Mill", averagePrice: 1839 },
  ],
};

export const PARKSIDE_PROJECT: SynthProjectSpec = {
  slug: "parkside-grove-testburg",
  buildingId: 300,
  name: "Parkside Grove",
  district: { id: 12, name: "Hillcrest" },
  city: "Greenvale",
  developer: "Acme Build",
  lat: 41.676,
  lng: 44.753,
  constructionStatus: "construction",
  buildingType: "cottage",
  renovation: "green frame",
  minPrice: 312000,
  minPriceSqm: 1300,
  pricesUpdateTime: "2026-07-22T04:12:53+00:00",
  units: [
    { name: "1-room flats", roomCount: 1, areaMin: 244, areaMax: 244, priceMin: 317200, priceMax: 317200, minPriceSqm: 1300 },
    { name: "2-room flats", roomCount: 2, areaMin: 240, areaMax: 302, priceMin: 312000, priceMax: 392600, minPriceSqm: 1300 },
  ],
};

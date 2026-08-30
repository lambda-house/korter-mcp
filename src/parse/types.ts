/**
 * What a single korter page yields. Shapes follow docs/schema-notes.md — the
 * Phase 0 recon — not wishful thinking about what korter might expose.
 *
 * Every numeric price is in the page's single currency (`currency`), never
 * converted. `pricesAsOf: null` means korter showed no date on this page type
 * (listing cards never carry one), not that the price is fresh.
 */

export type Currency = "USD" | "GEL";

/** One entry of a project page's prices.unitTypes[] — the per-unit breakdown. */
export interface UnitTypeObservation {
  /** korter's label, e.g. "2-room townhouses". */
  name: string;
  propertyType: string | null;
  roomCount: number | null;
  areaMin: number | null;
  areaMax: number | null;
  /** Page currency, like every price in an observation. */
  priceMin: number | null;
  priceMax: number | null;
  pricePerM2Min: number | null;
  allSold: boolean;
}

export interface ProjectObservation {
  /** korter slug, e.g. "tsavkisi-park-tbilisi" — the entity id. */
  slug: string;
  korterId: number | null;
  name: string | null;
  address: string | null;
  /** korter's own taxonomy name, as-is ("Isani", "Mtatsminda"). */
  district: string | null;
  city: string | null;
  developer: string | null;
  lat: number | null;
  lng: number | null;
  constructionStatus: string | null;
  salesStatus: string | null;
  buildingType: string | null;
  /** minPrice; 0 and missing both mean "not shown" → null. */
  priceFrom: number | null;
  pricePerM2: number | null;
  /** main.pricesUpdateTime, ISO 8601. Project pages only. */
  pricesAsOf: string | null;
  /**
   * Per-unit breakdown (rooms, areas, price ranges). Project pages only —
   * null means "this page type does not carry it", never "no units".
   */
  unitTypes: UnitTypeObservation[] | null;
  /** main.renovation, e.g. "green frame". Project pages only. */
  renovation: string | null;
  isDeleted: boolean;
}

export interface GeoObjectNode {
  id: number;
  name: string;
  category: string;
  /** Listing link path ("/en/new-projects-tbilisi-isani-district") or null. */
  link: string | null;
  children: GeoObjectNode[];
}

export interface DistrictAvgPrice {
  id: number;
  name: string;
  /** Average price per m² in the page currency, korter's own figure. */
  averagePrice: number | null;
  link: string | null;
}

export interface ListingPage {
  pageType: "listing";
  /** Slug of the listing itself, e.g. "new-projects-in-avlabari". */
  slug: string;
  currency: Currency;
  projects: ProjectObservation[];
  taxonomy: GeoObjectNode | null;
  districtAvgPrices: DistrictAvgPrice[];
  totalCount: number | null;
}

export interface ProjectPage {
  pageType: "project";
  slug: string;
  currency: Currency;
  /** Exactly one entry — kept as a list so callers treat both pages alike. */
  projects: ProjectObservation[];
}

/**
 * One secondary-market card (apartmentListingStore.apartments[]). Property
 * facts only: korter's numeric userId is dropped at parse time and no
 * seller name/phone exists in the page state at all — buyers follow `link`
 * to korter and deal with the seller there.
 */
export interface SecondaryListing {
  objectId: number;
  section: "sale" | "rent";
  /** korter path of the listing, e.g. "/en/apartments-for-sale-tbilisi/…/705707". */
  link: string;
  buildingName: string | null;
  buildingSlug: string | null;
  address: string | null;
  district: string | null;
  city: string | null;
  /** Page currency. Sale: total price; rent: per month. */
  price: number | null;
  areaM2: number | null;
  /** price/area, rounded — $/m² for sale, monthly $/m² for rent. */
  pricePerM2: number | null;
  roomCount: number | null;
  propertyType: string | null;
  floor: number | null;
  floorCount: number | null;
  lat: number | null;
  lng: number | null;
  /** korter's own per-listing freshness date. */
  actualizeTime: string | null;
  availableStatus: string | null;
}

/** korter's secondary-market aggregates per district (carried on every page). */
export interface SecondaryDistrictAggregate {
  id: number;
  name: string;
  avgPriceSqm: number | null;
  salePriceMin: number | null;
  salePriceMax: number | null;
  rentMin: number | null;
  rentMax: number | null;
  saleLink: string | null;
  rentLink: string | null;
}

export interface SecondaryPage {
  pageType: "secondary";
  slug: string;
  currency: Currency;
  section: "sale" | "rent";
  listings: SecondaryListing[];
  /** korter's total for the filter, not just this page (pages carry ~20). */
  totalCount: number | null;
  /** The district this page is scoped to, when korter says (routeParams). */
  focusDistrictId: number | null;
  /** geoObjectsAvgPrices.geoObject.nominative, e.g. "Vake District". */
  focusDistrictName: string | null;
  aggregates: SecondaryDistrictAggregate[];
}

export type PageObservation = ListingPage | ProjectPage | SecondaryPage;

/** Raised when a page does not contain what schema-notes.md says it must. */
export class ParseError extends Error {
  constructor(readonly reason: string) {
    super(`korter page parse failed: ${reason}`);
    this.name = "ParseError";
  }
}

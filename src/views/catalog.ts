/**
 * Catalog projection — the current card per project, folded from the Project
 * journal. This is the only store-backed projection; it must stay rebuildable
 * from the journal (a projection you cannot rebuild is a second source of
 * truth). Reads for search_projects/get_project come from here, never from an
 * aggregate.
 */
import { projection, type SingleStreamProjection } from "@lambda-house/teob-ts/projection";
import type { Currency, UnitTypeObservation } from "../parse/types.js";
import type { ObservedAttrs, PriceState, ProjectEvent } from "../domain/types.js";

export interface CatalogCard {
  slug: string;
  attrs: ObservedAttrs;
  attrsObservedAt: string | null;
  discoveredAt: string | null;
  discoveredFrom: string | null;
  prices: Partial<Record<Currency, PriceState>>;
  /** Per-unit breakdown; null until a project page has been observed. */
  unitTypes: UnitTypeObservation[] | null;
  unitTypesObservedAt: string | null;
  delisted: boolean;
  /** Timestamp of the latest journal event folded into this card. */
  lastObservedAt: string | null;
}

export const CATALOG_PROJECTION_ID = "catalog";

export const catalogProjection: SingleStreamProjection<ProjectEvent, CatalogCard> = projection({
  projectionId: CATALOG_PROJECTION_ID,
  category: "project",
  initialState: (): CatalogCard => ({
    slug: "",
    attrs: {},
    attrsObservedAt: null,
    discoveredAt: null,
    discoveredFrom: null,
    prices: {},
    unitTypes: null,
    unitTypesObservedAt: null,
    delisted: false,
    lastObservedAt: null,
  }),
  evolve: (view, event, entityId): CatalogCard => {
    const base: CatalogCard = { ...view, slug: entityId as string, lastObservedAt: event.observedAt };
    switch (event.tag) {
      case "ProjectDiscovered":
        return { ...base, discoveredAt: event.observedAt, discoveredFrom: event.sourceUrl };
      case "AttributesObserved": {
        const { tag, observedAt, ...attrs } = event;
        return { ...base, attrs: { ...view.attrs, ...attrs }, attrsObservedAt: observedAt };
      }
      case "PriceObserved":
        return {
          ...base,
          prices: {
            ...view.prices,
            [event.currency]: {
              priceFrom: event.priceFrom,
              pricePerM2: event.pricePerM2,
              pricesAsOf: event.pricesAsOf,
              observedAt: event.observedAt,
              sourceUrl: event.sourceUrl,
            } satisfies PriceState,
          },
        };
      case "StalenessObserved": {
        const prev = view.prices[event.currency];
        if (!prev) return base;
        return {
          ...base,
          prices: {
            ...view.prices,
            [event.currency]: { ...prev, pricesAsOf: event.pricesAsOf, observedAt: event.observedAt },
          },
        };
      }
      case "UnitTypesObserved":
        return { ...base, unitTypes: event.unitTypes, unitTypesObservedAt: event.observedAt };
      case "ProjectDelisted":
        return { ...base, delisted: true };
    }
  },
});

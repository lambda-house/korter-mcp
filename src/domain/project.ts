/**
 * Project aggregate — the observation sink. Its journal is the price history;
 * there is no price_history table anywhere in this repo.
 *
 * The dedup rule lives here and only here, as a pure function:
 *  - identical price + identical known pricesAsOf        → done(), no event
 *  - identical price + a NEW non-null pricesAsOf         → StalenessObserved
 *  - pricesAsOf null (listing card) never overwrites a known date and never
 *    triggers StalenessObserved — otherwise listing/project alternation for
 *    the same slug would ping-pong events that record nothing.
 */
import {
  type Aggregate,
  andReply,
  done,
  type Effect,
  type EntityId,
  persist,
  reply,
} from "@lambda-house/teob-ts/core";
import type { Currency, ProjectObservation, UnitTypeObservation } from "../parse/types.js";
import {
  type ObservedAttrs,
  PROJECT_CATEGORY,
  type PriceState,
  type ProjectCommand,
  type ProjectEvent,
  type ProjectReply,
  type ProjectState,
} from "./types.js";

export const projectAggregate: Aggregate<ProjectCommand, ProjectReply, ProjectEvent, ProjectState> = {
  category: PROJECT_CATEGORY,

  initial(_id: EntityId): ProjectState {
    return {
      discovered: false,
      attrs: {},
      attrsObservedAt: null,
      prices: {},
      unitTypes: null,
      unitTypesObservedAt: null,
      delisted: false,
      discoveredAt: null,
    };
  },

  async decide(state, command, ctx): Promise<Effect<ProjectEvent, ProjectReply>> {
    switch (command.tag) {
      case "Observe": {
        if (state.delisted) {
          // A delisted project accepts no further prices (invariant). korter
          // re-listing a project would need explicit human intent to resume.
          return reply({ tag: "Rejected", reason: "project is delisted" });
        }
        const events: ProjectEvent[] = [];
        if (!state.discovered) {
          events.push({
            tag: "ProjectDiscovered",
            slug: ctx.entityId as string,
            sourceUrl: command.sourceUrl,
            observedAt: command.observedAt,
          });
        }

        const changedAttrs = diffAttrs(state.attrs, command.obs);
        if (Object.keys(changedAttrs).length > 0) {
          events.push({ tag: "AttributesObserved", observedAt: command.observedAt, ...changedAttrs });
        }

        const priceEvent = decidePrice(state, command.obs, command.currency, command);
        if (priceEvent) events.push(priceEvent);

        // Unit breakdown: journal only when a project page shows a different
        // set than we know. Listing cards (unitTypes null) never clear it.
        if (command.obs.unitTypes !== null && unitTypesChanged(state.unitTypes, command.obs.unitTypes)) {
          events.push({
            tag: "UnitTypesObserved",
            unitTypes: command.obs.unitTypes,
            currency: command.currency,
            observedAt: command.observedAt,
          });
        }

        if (command.obs.isDeleted) {
          events.push({ tag: "ProjectDelisted", observedAt: command.observedAt, reason: "korter marks it deleted" });
        }

        if (events.length === 0) return done(); // the dedup rule: nothing changed, nothing written
        return andReply(persist(...events), { tag: "Ok" });
      }

      case "MarkDelisted": {
        if (state.delisted) return done();
        if (!state.discovered) return done(); // nothing to delist; don't invent an entity
        return andReply(
          persist({ tag: "ProjectDelisted", observedAt: command.observedAt, reason: command.reason }),
          { tag: "Ok" },
        );
      }
    }
  },

  apply(state, event): ProjectState {
    switch (event.tag) {
      case "ProjectDiscovered":
        return { ...state, discovered: true, discoveredAt: event.observedAt };
      case "AttributesObserved": {
        const { tag, observedAt, ...attrs } = event;
        return { ...state, attrs: { ...state.attrs, ...attrs }, attrsObservedAt: observedAt };
      }
      case "PriceObserved": {
        const next: PriceState = {
          priceFrom: event.priceFrom,
          pricePerM2: event.pricePerM2,
          pricesAsOf: event.pricesAsOf,
          observedAt: event.observedAt,
          sourceUrl: event.sourceUrl,
        };
        return { ...state, prices: { ...state.prices, [event.currency]: next } };
      }
      case "StalenessObserved": {
        const prev = state.prices[event.currency];
        if (!prev) return state;
        return {
          ...state,
          prices: {
            ...state.prices,
            [event.currency]: { ...prev, pricesAsOf: event.pricesAsOf, observedAt: event.observedAt },
          },
        };
      }
      case "UnitTypesObserved":
        return { ...state, unitTypes: event.unitTypes, unitTypesObservedAt: event.observedAt };
      case "ProjectDelisted":
        return { ...state, delisted: true };
    }
  },

  invariants: [
    {
      name: "prices carry at most one entry per currency",
      check: (state) => Object.keys(state.prices).every((c) => c === "USD" || c === "GEL"),
    },
    {
      name: "a price is only known on a discovered project",
      check: (state) => state.discovered || Object.keys(state.prices).length === 0,
    },
  ],
};

function unitTypesChanged(known: UnitTypeObservation[] | null, observed: UnitTypeObservation[]): boolean {
  if (known === null) return true;
  const normalize = (units: UnitTypeObservation[]): string =>
    JSON.stringify([...units].sort((a, b) => a.name.localeCompare(b.name)));
  return normalize(known) !== normalize(observed);
}

function diffAttrs(current: ObservedAttrs, obs: ProjectObservation): ObservedAttrs {
  const observed: ObservedAttrs = {};
  setIf(observed, "name", obs.name, current.name);
  setIf(observed, "address", obs.address, current.address);
  setIf(observed, "district", obs.district, current.district);
  setIf(observed, "city", obs.city, current.city);
  setIf(observed, "developer", obs.developer, current.developer);
  setIf(observed, "lat", obs.lat, current.lat);
  setIf(observed, "lng", obs.lng, current.lng);
  setIf(observed, "constructionStatus", obs.constructionStatus, current.constructionStatus);
  setIf(observed, "salesStatus", obs.salesStatus, current.salesStatus);
  setIf(observed, "buildingType", obs.buildingType, current.buildingType);
  setIf(observed, "korterId", obs.korterId, current.korterId);
  setIf(observed, "renovation", obs.renovation, current.renovation);
  return observed;
}

/** Record a field only when korter showed it AND it differs from what we know. */
function setIf<K extends keyof ObservedAttrs>(
  target: ObservedAttrs,
  key: K,
  observed: ObservedAttrs[K] | null,
  known: ObservedAttrs[K] | undefined,
): void {
  if (observed !== null && observed !== undefined && observed !== known) {
    target[key] = observed;
  }
}

function decidePrice(
  state: ProjectState,
  obs: ProjectObservation,
  currency: Currency,
  meta: { sourceUrl: string; sourceHash: string; observedAt: string },
): ProjectEvent | null {
  const prev = state.prices[currency];
  const hasPrice = obs.priceFrom !== null || obs.pricePerM2 !== null;

  if (!prev) {
    if (!hasPrice) return null; // korter shows no price yet — nothing to record
    return priceObserved(obs, currency, meta);
  }

  const valuesChanged = obs.priceFrom !== prev.priceFrom || obs.pricePerM2 !== prev.pricePerM2;
  if (valuesChanged) {
    // Includes prices disappearing (both null after being known): that IS a change.
    return priceObserved(obs, currency, meta);
  }

  if (obs.pricesAsOf !== null && obs.pricesAsOf !== prev.pricesAsOf) {
    // korter re-dated the card without moving the price: the card is being
    // maintained, not abandoned. A distinct fact, worth a distinct event.
    return { tag: "StalenessObserved", currency, pricesAsOf: obs.pricesAsOf, observedAt: meta.observedAt };
  }

  return null;
}

function priceObserved(
  obs: ProjectObservation,
  currency: Currency,
  meta: { sourceUrl: string; sourceHash: string; observedAt: string },
): ProjectEvent {
  return {
    tag: "PriceObserved",
    priceFrom: obs.priceFrom,
    pricePerM2: obs.pricePerM2,
    currency,
    pricesAsOf: obs.pricesAsOf,
    observedAt: meta.observedAt,
    sourceUrl: meta.sourceUrl,
    sourceHash: meta.sourceHash,
  };
}

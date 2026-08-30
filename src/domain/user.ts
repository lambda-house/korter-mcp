/**
 * User aggregate — one entity per authenticated subject (the IdP `sub` claim
 * Pomerium forwards). This is where "privacy done properly" lives:
 *
 *  - Consent is EVENT-SOURCED: ConsentGranted/ConsentRevoked with the notice
 *    text version and timestamp, append-only — an auditable consent log.
 *  - Terms consent and the marketing opt-in are SEPARATE consents; marketing
 *    is optional and never a condition of using the tools (bundled consent is
 *    not valid consent).
 *  - InterestObserved records only the search criteria a consented user
 *    stated (district/budget/rooms/…): the profile that powers "offers on
 *    this topic" for users who opted in. No free text, no results, and
 *    identical-to-last interests are not re-journaled.
 */
import {
  type Aggregate,
  andReply,
  CategoryId,
  categoryTypes,
  type Effect,
  type EntityId,
  objectCodec,
  persist,
  reply,
  tagCodec,
} from "@lambda-house/teob-ts/core";

export const USER_CATEGORY = CategoryId("user");

/** Bump when the notice text in skills.ts changes; re-consent is then required. */
export const PRIVACY_VERSION = "2026-08-30.1";

export type ConsentKind = "terms" | "marketing";

export interface Interest {
  tool: string;
  section?: string;
  district?: string;
  city?: string;
  rooms?: number;
  minAreaM2?: number;
  maxAreaM2?: number;
  maxBudget?: number;
  maxPricePerM2?: number;
  slug?: string;
}

export type UserCommand =
  | { tag: "Touch"; email?: string; name?: string; provider?: string; at: string }
  | { tag: "GrantConsent"; kind: ConsentKind; textVersion: string; at: string }
  | { tag: "RevokeConsent"; kind: ConsentKind; at: string }
  | { tag: "ObserveInterest"; interest: Interest; at: string }
  | { tag: "GetProfile" };

export interface ConsentState {
  textVersion: string;
  at: string;
}

export interface UserState {
  registered: boolean;
  email: string | null;
  name: string | null;
  provider: string | null;
  firstSeenAt: string | null;
  consents: Partial<Record<ConsentKind, ConsentState | null>>;
  lastInterestKey: string | null;
  interestCount: number;
}

export type UserReply =
  | { tag: "Ok" }
  | { tag: "Profile"; state: UserState };

export type UserEvent =
  | { tag: "UserRegistered"; email?: string; name?: string; provider?: string; at: string }
  | { tag: "ProfileObserved"; email?: string; name?: string; at: string }
  | { tag: "ConsentGranted"; kind: ConsentKind; textVersion: string; at: string }
  | { tag: "ConsentRevoked"; kind: ConsentKind; at: string }
  | ({ tag: "InterestObserved"; at: string } & Interest);

export const userCategory = categoryTypes<UserCommand, UserReply>(USER_CATEGORY);
export const userEventCodec = tagCodec<UserEvent>(
  "UserRegistered",
  "ProfileObserved",
  "ConsentGranted",
  "ConsentRevoked",
  "InterestObserved",
);
export const userStateCodec = objectCodec<UserState>("UserState");

const interestKey = (i: Interest): string => JSON.stringify(i);

export const userAggregate: Aggregate<UserCommand, UserReply, UserEvent, UserState> = {
  category: USER_CATEGORY,

  initial(_id: EntityId): UserState {
    return {
      registered: false,
      email: null,
      name: null,
      provider: null,
      firstSeenAt: null,
      consents: {},
      lastInterestKey: null,
      interestCount: 0,
    };
  },

  async decide(state, command): Promise<Effect<UserEvent, UserReply>> {
    switch (command.tag) {
      case "Touch": {
        if (!state.registered) {
          return andReply(
            persist({
              tag: "UserRegistered",
              ...(command.email ? { email: command.email } : {}),
              ...(command.name ? { name: command.name } : {}),
              ...(command.provider ? { provider: command.provider } : {}),
              at: command.at,
            }),
            { tag: "Ok" },
          );
        }
        const emailChanged = command.email !== undefined && command.email !== state.email;
        const nameChanged = command.name !== undefined && command.name !== state.name;
        if (emailChanged || nameChanged) {
          return andReply(
            persist({
              tag: "ProfileObserved",
              ...(emailChanged ? { email: command.email } : {}),
              ...(nameChanged ? { name: command.name } : {}),
              at: command.at,
            }),
            { tag: "Ok" },
          );
        }
        return reply({ tag: "Ok" });
      }

      case "GrantConsent": {
        const current = state.consents[command.kind];
        if (current && current.textVersion === command.textVersion) return reply({ tag: "Ok" });
        return andReply(
          persist({ tag: "ConsentGranted", kind: command.kind, textVersion: command.textVersion, at: command.at }),
          { tag: "Ok" },
        );
      }

      case "RevokeConsent": {
        if (!state.consents[command.kind]) return reply({ tag: "Ok" });
        return andReply(persist({ tag: "ConsentRevoked", kind: command.kind, at: command.at }), { tag: "Ok" });
      }

      case "ObserveInterest": {
        // Only meaningful for consented users; the caller enforces that.
        if (interestKey(command.interest) === state.lastInterestKey) return reply({ tag: "Ok" });
        return andReply(
          persist({ tag: "InterestObserved", at: command.at, ...command.interest }),
          { tag: "Ok" },
        );
      }

      case "GetProfile":
        return reply({ tag: "Profile", state });
    }
  },

  apply(state, event): UserState {
    switch (event.tag) {
      case "UserRegistered":
        return {
          ...state,
          registered: true,
          email: event.email ?? state.email,
          name: event.name ?? state.name,
          provider: event.provider ?? state.provider,
          firstSeenAt: event.at,
        };
      case "ProfileObserved":
        return { ...state, email: event.email ?? state.email, name: event.name ?? state.name };
      case "ConsentGranted":
        return {
          ...state,
          consents: { ...state.consents, [event.kind]: { textVersion: event.textVersion, at: event.at } },
        };
      case "ConsentRevoked":
        return { ...state, consents: { ...state.consents, [event.kind]: null } };
      case "InterestObserved": {
        const { tag, at, ...interest } = event;
        return { ...state, lastInterestKey: interestKey(interest), interestCount: state.interestCount + 1 };
      }
    }
  },

  invariants: [
    {
      name: "consent kinds are known",
      check: (state) => Object.keys(state.consents).every((k) => k === "terms" || k === "marketing"),
    },
  ],
};

/** Terms consent valid for the CURRENT notice version? */
export function hasTermsConsent(state: UserState): boolean {
  return state.consents["terms"]?.textVersion === PRIVACY_VERSION;
}

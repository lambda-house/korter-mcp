/**
 * Per-request identity, threaded from the HTTP layer to tool execution via
 * AsyncLocalStorage (the MCP dispatcher itself is transport-agnostic and never
 * sees headers).
 *
 * Trust model: identity claims are read ONLY on requests carrying the valid
 * Pomerium marker — Pomerium authenticated the user with the IdP and injects
 * the claim headers; nothing else can reach the endpoint with that marker.
 * Local stdio and the operator bearer path have no IdP identity: `null`
 * (local process — the operator's own machine) and `{ operator: true }`.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface Identity {
  /** Stable subject from the IdP (Pomerium X-Pomerium-Claim-Sub). */
  sub: string;
  email: string | null;
  name: string | null;
  provider: string | null;
  operator: boolean;
}

const storage = new AsyncLocalStorage<Identity>();

export function runWithIdentity<T>(identity: Identity | null, fn: () => T): T {
  return identity ? storage.run(identity, fn) : fn();
}

export function currentIdentity(): Identity | null {
  return storage.getStore() ?? null;
}

export function identityFromClaims(headers: {
  sub?: string;
  email?: string;
  name?: string;
  idp?: string;
}, operatorEmails: readonly string[]): Identity | null {
  if (!headers.sub) return null;
  const email = headers.email ?? null;
  return {
    sub: headers.sub,
    email,
    name: headers.name ?? null,
    provider: headers.idp ?? null,
    operator: email !== null && operatorEmails.some((a) => a.toLowerCase() === email.toLowerCase()),
  };
}

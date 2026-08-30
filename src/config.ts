/**
 * Operating constraints, as code.
 *
 * These are not tuning knobs. They are the terms on which this tool is allowed
 * to touch korter.ge at all (see CLAUDE.md § Hard rules). Raising RATE_LIMIT_MS,
 * softening USER_AGENT, or adding a retry path for 403/429 is a change to the
 * ethics of the tool, not to its performance.
 */

/** Honest and identifiable. Never rotated, never disguised. */
export const USER_AGENT = "korter-mcp/0.1 (personal research tool)";

/** Global floor between the *starts* of two outbound requests, all callers. */
export const RATE_LIMIT_MS = 1000;

/** Raw page cache TTL. Cache-first is how request volume stays trivial. */
export const PAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Per-request timeout for a korter fetch. */
export const FETCH_TIMEOUT_MS = 15_000;

/** Retries, on 5xx and timeout only. Never on 403/429. */
export const FETCH_MAX_RETRIES = 3;

/** Default sweep interval for the Tracker. Weekly. */
export const SWEEP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export const KORTER_ORIGIN = "https://korter.ge";

export type Mode = "stdio" | "serve" | "sweep";

export interface Config {
  mode: Mode;
  /**
   * SQLite journal path. The prod deployment also runs SQLite (on a PVC):
   * teob-ts 0.4.0 has no Postgres projection store, live tails or journal
   * reader, and this corpus is a handful of entities — decided 2026-08-30,
   * see README § storage.
   */
  dbPath: string;
  /**
   * "remote" makes stdio a thin facade over the prod read API and disables all
   * fetching here, so one history accrues from one scraper.
   */
  korterMode: "local" | "remote";
  /** Base URL of the prod service when korterMode is "remote". */
  remoteBaseUrl?: string;
  /** Bearer token for the prod read API (remote mode client side). */
  remoteToken?: string;
  sweepIntervalMs: number;
  /** serve mode: HTTP port for /api + /mcp (probes are on 9095). */
  httpPort: number;
  /** serve mode: bearer token required on /api. Mandatory — hard rule 7. */
  apiToken?: string;
  /** serve mode: shared marker Pomerium injects; /mcp requires it. Mandatory. */
  pomeriumToken?: string;
  /**
   * Emails treated as operators on the hosted endpoint (full tool surface, no
   * consent gate, no tracking). Everyone else is an end user: consent-gated
   * reads only.
   */
  adminEmails: string[];
}

export function loadConfig(argv: readonly string[], env: NodeJS.ProcessEnv): Config {
  const mode = parseMode(argv[0]);
  const korterMode = env.KORTER_MODE === "remote" ? "remote" : "local";

  if (korterMode === "remote" && !env.KORTER_REMOTE_URL) {
    throw new Error("KORTER_MODE=remote requires KORTER_REMOTE_URL");
  }

  return {
    mode,
    dbPath: env.KORTER_DB_PATH ?? "./data/korter.db",
    korterMode,
    remoteBaseUrl: env.KORTER_REMOTE_URL,
    remoteToken: env.KORTER_REMOTE_TOKEN,
    sweepIntervalMs: env.KORTER_SWEEP_INTERVAL_MS
      ? Number(env.KORTER_SWEEP_INTERVAL_MS)
      : SWEEP_INTERVAL_MS,
    httpPort: env.PORT ? Number(env.PORT) : 8080,
    apiToken: env.KORTER_API_TOKEN,
    pomeriumToken: env.KORTER_POMERIUM_TOKEN,
    adminEmails: (env.KORTER_ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim())
      .filter((e) => e.length > 0),
  };
}

function parseMode(arg: string | undefined): Mode {
  switch (arg) {
    case undefined:
    case "stdio":
      return "stdio";
    case "serve":
      return "serve";
    case "sweep":
      return "sweep";
    default:
      throw new Error(`unknown mode "${arg}" — expected stdio | serve | sweep`);
  }
}

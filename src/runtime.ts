/**
 * Assembly: one SQLite file holds the journal, the projection store, the page
 * cache and the district table. Everything that talks to korter goes through
 * one pacer and one gateway.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createMCPToolRegistry, type MCPToolRegistry } from "@lambda-house/teob-ts/ai";
import { type EntityId, type EntityRuntime } from "@lambda-house/teob-ts/core";
import { createInMemoryRuntime, registration } from "@lambda-house/teob-ts/inmem";
import {
  createProjectionRunner,
  createSqliteProjectionStore,
  type ProjectionRunner,
  type ProjectionStore,
} from "@lambda-house/teob-ts/projection";
import { createSqliteCleanJournal, createSqliteJournal, type SqliteJournal } from "@lambda-house/teob-ts/sqlite";
import type { Config } from "./config.js";
import { projectAggregate } from "./domain/project.js";
import { createSourceAggregate } from "./domain/source.js";
import { createTrackerAggregate } from "./domain/tracker.js";
import { userAggregate, userEventCodec, userStateCodec } from "./domain/user.js";
import {
  projectEventCodec,
  projectStateCodec,
  SEED_SOURCES,
  SOURCE_CATEGORY,
  sourceEventCodec,
  sourceStateCodec,
  TRACKER_ID,
  trackerCategory,
  trackerEventCodec,
  trackerStateCodec,
} from "./domain/types.js";
import { createSqlitePageCache } from "./fetch/cache.js";
import { createKorterClient, type HttpFetch } from "./fetch/client.js";
import { createFetchGateway } from "./fetch/gateway.js";
import { createPacer, type Pacer } from "./fetch/pacer.js";
import { registerKorterTools } from "./mcp/tools.js";
import { catalogProjection } from "./views/catalog.js";
import { createDistrictStore, type DistrictStore } from "./views/districts.js";
import { createSecondaryStore, type SecondaryStore } from "./views/secondary.js";

export interface KorterService {
  runtime: EntityRuntime;
  journal: SqliteJournal;
  store: ProjectionStore;
  districts: DistrictStore;
  secondary: SecondaryStore;
  registry: MCPToolRegistry;
  runner: ProjectionRunner;
  pacer: Pacer;
  seedIfEmpty(): Promise<void>;
  /**
   * Retention (Phase 2): drop Source-category noise (FetchUnchanged & co.)
   * older than the cutoff. NEVER points at the Project category — those events
   * ARE the price history, and deleting them is deleting the product.
   */
  pruneSourceJournal(beforeMs?: number): number;
  close(): Promise<void>;
}

/** Source events older than this are prunable noise; the journal keeps 90 days. */
export const SOURCE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface ServiceOverrides {
  /** Test seam: replace the network. Everything else stays real. */
  httpFetch?: HttpFetch;
  sweepIntervalMs?: number;
  /** Test seam only — against a fake network. The real floor is RATE_LIMIT_MS. */
  pacerIntervalMs?: number;
}

export function createKorterService(
  config: Config,
  log: (msg: string) => void,
  overrides: ServiceOverrides = {},
): KorterService {
  if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });
  const journal = createSqliteJournal({ path: config.dbPath });

  const pacer = createPacer(overrides.pacerIntervalMs);
  const client = createKorterClient(pacer, overrides.httpFetch ? { httpFetch: overrides.httpFetch } : {});
  const cache = createSqlitePageCache(journal.db);
  const districts = createDistrictStore(journal.db);
  const secondary = createSecondaryStore(journal.db);
  const gateway = createFetchGateway({ client, cache });
  const cleanJournal = createSqliteCleanJournal(journal);

  const sourceAggregate = createSourceAggregate({
    fetchSource: gateway.fetchSource,
    sourceUrl: gateway.sourceUrl,
    saveDistricts: (page, fetchedAt) => districts.save(page, gateway.sourceUrl(`listing:${page.slug}`), fetchedAt),
    saveSecondary: (sourceId, page, fetchedAt) => secondary.save(sourceId, page, gateway.sourceUrl(sourceId), fetchedAt),
  });
  const trackerAggregate = createTrackerAggregate({
    sweepIntervalMs: overrides.sweepIntervalMs ?? config.sweepIntervalMs,
  });

  const { runtime } = createInMemoryRuntime(
    [
      registration(projectAggregate, projectEventCodec, projectStateCodec),
      registration(sourceAggregate, sourceEventCodec, sourceStateCodec),
      registration(trackerAggregate, trackerEventCodec, trackerStateCodec),
      registration(userAggregate, userEventCodec, userStateCodec),
    ],
    // A refresh can sit behind a sweep in the paced queue; the ask timeout
    // must outlive the Source's own fetch timeout (120s).
    { journal, askTimeoutMs: 150_000 },
  );

  const store = createSqliteProjectionStore(journal.db);
  const runner = createProjectionRunner({
    entries: [{ projection: catalogProjection, eventCodec: projectEventCodec }],
    journal,
    store,
    pollIntervalMs: 2_000,
    onError: (err) => log(`projection runner: ${err instanceof Error ? err.message : String(err)}`),
  });
  runner.runOnce();
  runner.start(); // timers are unref()'d — this never holds the process open

  const registry = createMCPToolRegistry();
  registerKorterTools(registry, {
    runtime,
    reader: journal,
    store,
    districts,
    secondary,
    refreshProjections: () => runner.runOnce(),
  });

  return {
    runtime,
    journal,
    store,
    districts,
    secondary,
    registry,
    runner,
    pacer,
    async seedIfEmpty(): Promise<void> {
      const asked = await runtime.ask(TRACKER_ID as EntityId, { tag: "GetTracked" }, trackerCategory);
      if (!asked.ok || asked.value.reply?.tag !== "Tracked") return;
      if (asked.value.reply.sourceIds.length > 0) return;
      log(`seeding tracked set: ${SEED_SOURCES.join(", ")}`);
      for (const sourceId of SEED_SOURCES) {
        await runtime.ask(TRACKER_ID as EntityId, { tag: "Track", sourceId }, trackerCategory);
      }
      // First boot: the sweep timer armed before seeding saw an empty set —
      // kick one sweep now so history starts accruing immediately.
      await runtime.ask(TRACKER_ID as EntityId, { tag: "RefreshNow" }, trackerCategory);
    },
    pruneSourceJournal(beforeMs = Date.now() - SOURCE_RETENTION_MS): number {
      return cleanJournal.deleteJournalEventsBefore(SOURCE_CATEGORY, beforeMs);
    },
    async close(): Promise<void> {
      await runner.stop();
      await runtime.shutdown();
      journal.close();
    },
  };
}

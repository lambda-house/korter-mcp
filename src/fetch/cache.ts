/**
 * Raw page cache. Deliberately NOT event-sourced (CLAUDE.md): a plain
 * url→(body, hash, fetched_at) table with a TTL. Events carry `sourceHash`, so
 * an observation stays traceable to its bytes while the cache holds them.
 */
import type Database from "better-sqlite3";
import { PAGE_CACHE_TTL_MS } from "../config.js";

export interface CachedPage {
  url: string;
  body: string;
  hash: string;
  fetchedAt: string;
}

export interface PageCache {
  /** Fresh entry or null. `now` injectable for tests. */
  get(url: string, nowMs?: number): CachedPage | null;
  put(page: CachedPage): void;
  purgeExpired(nowMs?: number): number;
}

export function createSqlitePageCache(db: Database.Database, ttlMs: number = PAGE_CACHE_TTL_MS): PageCache {
  db.exec(`
    CREATE TABLE IF NOT EXISTS page_cache (
      url        TEXT PRIMARY KEY,
      body       TEXT NOT NULL,
      hash       TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    )
  `);
  const select = db.prepare("SELECT url, body, hash, fetched_at AS fetchedAt FROM page_cache WHERE url = ?");
  const upsert = db.prepare(
    "INSERT INTO page_cache (url, body, hash, fetched_at) VALUES (@url, @body, @hash, @fetchedAt) " +
      "ON CONFLICT(url) DO UPDATE SET body = @body, hash = @hash, fetched_at = @fetchedAt",
  );
  const purge = db.prepare("DELETE FROM page_cache WHERE fetched_at < ?");

  return {
    get(url, nowMs = Date.now()): CachedPage | null {
      const row = select.get(url) as CachedPage | undefined;
      if (!row) return null;
      if (Date.parse(row.fetchedAt) + ttlMs <= nowMs) return null;
      return row;
    },
    put(page): void {
      upsert.run(page);
    },
    purgeExpired(nowMs = Date.now()): number {
      return purge.run(new Date(nowMs - ttlMs).toISOString()).changes;
    },
  };
}

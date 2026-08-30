/**
 * sweep mode — one-shot: refresh every tracked source, print the diff report,
 * exit. Useful locally and as the prod CronJob fallback if the in-process
 * timer proves fragile. stdout is safe here (no MCP stream) and is the report.
 */
import type { EntityId } from "@lambda-house/teob-ts/core";
import type { Config } from "./config.js";
import { sourceCategory, TRACKER_ID, trackerCategory } from "./domain/types.js";
import { createKorterService } from "./runtime.js";
import { diffReport } from "./views/history.js";

export async function runSweep(config: Config, log: (msg: string) => void): Promise<void> {
  const svc = createKorterService(config, log);
  const startedAt = Date.now();
  try {
    await svc.seedIfEmpty();
    const asked = await svc.runtime.ask(TRACKER_ID as EntityId, { tag: "GetTracked" }, trackerCategory);
    if (!asked.ok || asked.value.reply?.tag !== "Tracked") throw new Error("tracker unavailable");
    const tracked = asked.value.reply.sourceIds;
    log(`sweeping ${tracked.length} sources (paced at 1 req/s, cache-first)`);

    for (const sourceId of tracked) {
      const result = await svc.runtime.ask(sourceId as EntityId, { tag: "Refresh", force: false }, sourceCategory);
      const outcome = result.ok && result.value.reply?.tag === "Done" ? result.value.reply.outcome : null;
      log(`  ${sourceId}: ${outcome ? describeOutcome(outcome) : "no reply"}`);
      if (outcome?.tag === "Failed" && (outcome.kind === "blocked" || outcome.kind === "ratelimited" || outcome.kind === "breaker")) {
        log("  breaker is open — stopping the sweep here, by design");
        break;
      }
    }

    svc.runner.runOnce();
    const pruned = svc.pruneSourceJournal();
    if (pruned > 0) log(`retention: pruned ${pruned} old source-category events (project history untouched)`);
    printReport(startedAt, svc);
  } finally {
    await svc.close();
  }
}

function describeOutcome(outcome: { tag: string } & Record<string, unknown>): string {
  switch (outcome.tag) {
    case "Fetched":
      return `fetched (${String(outcome["projects"])} projects${outcome["fromCache"] === true ? ", from cache" : ""})`;
    case "Unchanged":
      return "unchanged";
    case "ParseFailed":
      return `PARSE FAILED: ${String(outcome["reason"])}`;
    default:
      return `failed: ${String(outcome["kind"])} — ${String(outcome["detail"])}`;
  }
}

function printReport(sinceMs: number, svc: ReturnType<typeof createKorterService>): void {
  const report = diffReport(svc.journal, sinceMs);
  const out = (line: string): void => void process.stdout.write(`${line}\n`);

  out(`korter-mcp sweep report — changes since ${report.since}`);
  if (
    report.priceChanges.length === 0 &&
    report.discovered.length === 0 &&
    report.delisted.length === 0 &&
    report.membership.length === 0
  ) {
    out("  no changes");
    return;
  }
  for (const c of report.priceChanges) {
    const fmt = (v: { priceFrom: number | null; pricePerM2: number | null; pricesAsOf: string | null } | null): string =>
      v ? `${v.pricePerM2 ?? "?"}/m² (from ${v.priceFrom ?? "?"}, as of ${v.pricesAsOf ?? "undated"})` : "nothing";
    out(`  ${c.slug} [${c.currency}]: ${fmt(c.from)} → ${fmt(c.to)}`);
  }
  for (const d of report.discovered) out(`  + discovered ${d.slug} (${d.sourceUrl})`);
  for (const d of report.delisted) out(`  - delisted ${d.slug}`);
  for (const m of report.membership) {
    out(`  ${m.listing}: +[${m.added.join(", ")}] -[${m.removed.join(", ")}]`);
  }
}

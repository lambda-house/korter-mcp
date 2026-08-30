/**
 * Live smoke test — the only file in the repo that touches korter.ge outside
 * the recon fixtures. Budget: 2 live requests (robots.txt + one project page),
 * paced and cache-first like everything else. Excluded from CI; `pnpm test`
 * stays zero-network.
 *
 * Run: pnpm run build && pnpm run smoke
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";
import { sourceCategory } from "../dist/domain/types.js";
import { createKorterService } from "../dist/runtime.js";

const log = (msg: string): void => void process.stderr.write(`smoke: ${msg}\n`);
const dir = mkdtempSync(join(tmpdir(), "korter-smoke-"));

async function main(): Promise<void> {
  const config = { ...loadConfig(["sweep"], process.env), dbPath: join(dir, "korter.db") };
  const svc = createKorterService(config, log);
  try {
    log("refreshing project:tsavkisi-park-tbilisi (2 live requests: robots.txt + page)");
    const asked = await svc.runtime.ask(
      "project:tsavkisi-park-tbilisi" as never,
      { tag: "Refresh", force: false },
      sourceCategory,
    );
    if (!asked.ok || asked.value.reply?.tag !== "Done") throw new Error(`refresh did not settle: ${JSON.stringify(asked)}`);
    const outcome = asked.value.reply.outcome;
    log(`outcome: ${JSON.stringify(outcome)}`);
    if (outcome.tag !== "Fetched") throw new Error(`expected a live fetch, got ${outcome.tag}`);

    svc.runner.runOnce();
    for (const [name, args] of [
      ["get_project", { slug: "tsavkisi-park-tbilisi" }],
      ["price_history", { slug: "tsavkisi-park-tbilisi" }],
      ["search_projects", { city: "Tsavkisi" }],
    ] as const) {
      const result = await svc.registry.execute({ name, arguments: args });
      if (!result.success) throw new Error(`${name} failed: ${result.error}`);
      process.stdout.write(`\n=== ${name} ===\n${JSON.stringify(result.output, null, 2)}\n`);
    }

    const card = (await svc.registry.execute({ name: "get_project", arguments: { slug: "tsavkisi-park-tbilisi" } }))
      .output as Record<string, unknown>;
    for (const field of ["source_url", "fetched_at", "prices_as_of", "observed_at", "staleness_days"]) {
      if (!(field in card)) throw new Error(`envelope field missing: ${field}`);
    }
    log("envelope complete; smoke PASSED");
  } finally {
    await svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e: unknown) => {
  log(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exitCode = 1;
});

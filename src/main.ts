/**
 * Mode dispatch.
 *
 * stdout belongs to the MCP JSON-RPC stream (stdio mode) or the sweep report
 * (sweep mode) and to nothing else. Every diagnostic in this process goes to
 * stderr — a single stray console.log is the most common way a stdio MCP
 * server dies, and it dies silently.
 */
import { createMCPServer, serveStdio } from "@lambda-house/teob-ts/mcp-server";
import { loadConfig } from "./config.js";
import { runRemoteStdio } from "./remote.js";
import { createKorterService } from "./runtime.js";
import { SERVER_INFO, SERVER_INSTRUCTIONS } from "./server-info.js";
import { runServe } from "./serve.js";
import { runSweep } from "./sweep.js";

const log = (msg: string): void => {
  process.stderr.write(`korter-mcp: ${msg}\n`);
};

// Belt and braces for stdio mode: console.* must never reach stdout.
function redirectConsoleToStderr(): void {
  for (const method of ["log", "info", "debug", "warn", "error"] as const) {
    console[method] = (...args: unknown[]): void => {
      process.stderr.write(`${args.map(String).join(" ")}\n`);
    };
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.argv.slice(2), process.env);
  log(`mode=${config.mode} korterMode=${config.korterMode} db=${config.dbPath}`);

  switch (config.mode) {
    case "stdio": {
      redirectConsoleToStderr();
      if (config.korterMode === "remote") {
        await runRemoteStdio(config, log);
        return;
      }
      const svc = createKorterService(config, log);
      const server = createMCPServer({
        registry: svc.registry,
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
        log: (level, msg) => log(`[mcp:${level}] ${msg}`),
      });
      // Seeding may kick a first background sweep; it must not block serving.
      void svc.seedIfEmpty().catch((e: unknown) => log(`seed failed: ${e instanceof Error ? e.message : String(e)}`));
      await serveStdio(server); // resolves on stdin EOF — the graceful shutdown signal
      await svc.close();
      return;
    }
    case "serve":
      await runServe(config, log);
      return;
    case "sweep":
      await runSweep(config, log);
      return;
  }
}

main().catch((err: unknown) => {
  log(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});

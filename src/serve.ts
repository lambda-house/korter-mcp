/**
 * serve mode — the long-lived prod service. Probes on 9095, HTTP on 8080:
 *   /api/tools           GET  — tool definitions (for the remote stdio facade)
 *   /api/tools/:name     POST — execute a tool; body = arguments JSON
 *   /mcp                 POST — Streamable HTTP MCP endpoint
 *
 * Auth (hard rule 7 — an open endpoint would turn a personal research tool
 * into a public scraper fronting someone else's site):
 *   /api requires Authorization: Bearer <KORTER_API_TOKEN>.
 *   /mcp requires the x-pomerium-backend-auth marker Pomerium injects, so only
 *   traffic that passed Pomerium's OAuth reaches it. Both are mandatory; serve
 *   mode refuses to start without them.
 */
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { createMCPServer, mcpHono } from "@lambda-house/teob-ts/mcp-server";
import {
  buildService,
  HealthStatus,
  type LifecycleLogger,
  type ServiceTemplate,
  simpleHealthCheck,
} from "@lambda-house/teob-ts/service";
import type { Config } from "./config.js";
import { identityFromClaims, runWithIdentity } from "./mcp/identity.js";
import { createKorterService, type KorterService } from "./runtime.js";
import { SERVER_INFO, SERVER_INSTRUCTIONS } from "./server-info.js";

const ALLOWED_ORIGINS = ["https://claude.ai", "https://claude.com"];

export async function runServe(config: Config, log: (msg: string) => void): Promise<void> {
  const apiToken = config.apiToken;
  const pomeriumToken = config.pomeriumToken;
  if (!apiToken || !pomeriumToken) {
    throw new Error(
      "serve mode requires KORTER_API_TOKEN and KORTER_POMERIUM_TOKEN — the /mcp and /api endpoints must be authenticated (CLAUDE.md hard rule 7)",
    );
  }

  const template: ServiceTemplate<KorterService, Record<never, never>, Record<never, never>, KorterService> = {
    config: {
      probeServer: { host: "0.0.0.0", port: 9095 },
      httpServer: { host: "0.0.0.0", port: config.httpPort },
    },

    async infra(): Promise<KorterService> {
      return createKorterService(config, log);
    },
    async outside(): Promise<Record<never, never>> {
      return {};
    },
    async entities(): Promise<Record<never, never>> {
      return {};
    },
    async context(svc): Promise<KorterService> {
      await svc.seedIfEmpty();
      return svc;
    },

    metricsExporter(svc) {
      return async () =>
        [
          "# HELP korter_breaker_open 1 when korter blocked us and the tool stopped, by design",
          "# TYPE korter_breaker_open gauge",
          `korter_breaker_open ${svc.pacer.isOpen() ? 1 : 0}`,
          "# HELP korter_journal_global_seq highest journal sequence (history accruing = this moves weekly)",
          "# TYPE korter_journal_global_seq gauge",
          `korter_journal_global_seq ${svc.journal.lastGlobalSeq()}`,
          "",
        ].join("\n");
    },

    infraHealthChecks(svc) {
      return [
        simpleHealthCheck("journal", async () => {
          svc.journal.lastGlobalSeq();
          return HealthStatus.Healthy;
        }),
        simpleHealthCheck("korter-breaker", async () =>
          svc.pacer.isOpen()
            ? HealthStatus.Degraded(`circuit breaker open: ${svc.pacer.tripReason() ?? "korter blocked us"}`)
            : HealthStatus.Healthy,
        ),
      ];
    },

    componentExports(svc) {
      const app = new Hono();

      const api = new Hono();
      api.use("*", async (c, next) => {
        const auth = c.req.header("authorization") ?? "";
        if (!constantTimeEquals(auth, `Bearer ${apiToken}`)) {
          return c.json({ error: "unauthorized" }, 401);
        }
        // The bearer is the operator's credential (remote facade, scripts).
        return runWithIdentity(
          { sub: "operator", email: null, name: null, provider: null, operator: true },
          () => next(),
        );
      });
      api.get("/tools", (c) => c.json({ tools: svc.registry.getDefinitions() }));
      api.post("/tools/:name", async (c) => {
        const name = c.req.param("name");
        const args: unknown = await c.req.json().catch(() => ({}));
        const result = await svc.registry.execute({ name, arguments: args });
        return c.json(result);
      });
      app.route("/api", api);

      const mcpServer = createMCPServer({
        registry: svc.registry,
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
        log: (level, msg) => log(`[mcp:${level}] ${msg}`),
      });
      const mcp = new Hono();
      mcp.use("*", async (c, next) => {
        const marker = c.req.header("x-pomerium-backend-auth") ?? "";
        if (!constantTimeEquals(marker, pomeriumToken)) {
          return c.json({ error: "unauthorized" }, 401);
        }
        // Claims are trusted ONLY behind the marker: Pomerium authenticated
        // the user at the IdP and injected these headers.
        const identity = identityFromClaims(
          {
            sub: c.req.header("x-pomerium-claim-sub"),
            email: c.req.header("x-pomerium-claim-email"),
            name: c.req.header("x-pomerium-claim-name"),
            idp: c.req.header("x-pomerium-claim-idp"),
          },
          config.adminEmails,
        );
        return runWithIdentity(identity, () => next());
      });
      mcp.route("/", mcpHono(mcpServer, { allowedOrigins: ALLOWED_ORIGINS }));
      app.route("/mcp", mcp);

      return { healthChecks: [], routes: app };
    },

    async teardownInfra(svc): Promise<void> {
      await svc.close();
    },
  };

  const service = await buildService(template, stderrLifecycleLogger(log));
  log(`korter-mcp serving: http :${config.httpPort} (/api, /mcp), probes :9095`);

  const shutdown = (): void => {
    log("shutting down");
    service
      .shutdown()
      .then(() => process.exit(0))
      .catch((e: unknown) => {
        log(`shutdown failed: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function stderrLifecycleLogger(log: (msg: string) => void): LifecycleLogger {
  return {
    starting: (phase) => log(`lifecycle: starting ${phase}`),
    started: (phase, ms) => log(`lifecycle: started ${phase} in ${ms}ms`),
    stopping: (phase) => log(`lifecycle: stopping ${phase}`),
    stopped: (phase) => log(`lifecycle: stopped ${phase}`),
    serviceReady: () => log("lifecycle: ready"),
    serviceShutdown: () => log("lifecycle: shutdown complete"),
  };
}

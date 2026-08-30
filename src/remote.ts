/**
 * KORTER_MODE=remote — stdio facade over the prod read API. Fetches nothing
 * from korter itself: one shared history, one scraper, no duplicate load.
 * Local mode stays the offline fallback.
 */
import { createMCPToolRegistry, MCPToolResultFactory as MCPToolResult, type MCPToolResult as MCPToolResultValue } from "@lambda-house/teob-ts/ai";
import { createMCPServer, serveStdio } from "@lambda-house/teob-ts/mcp-server";
import type { Config } from "./config.js";
import { SERVER_INFO, SERVER_INSTRUCTIONS } from "./server-info.js";

interface RemoteToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
}

export async function runRemoteStdio(config: Config, log: (msg: string) => void): Promise<void> {
  const base = config.remoteBaseUrl?.replace(/\/+$/, "");
  if (!base) throw new Error("KORTER_MODE=remote requires KORTER_REMOTE_URL");
  if (!config.remoteToken) throw new Error("KORTER_MODE=remote requires KORTER_REMOTE_TOKEN (the prod /api bearer token)");
  const headers = { authorization: `Bearer ${config.remoteToken}`, "content-type": "application/json" };

  const res = await fetch(`${base}/api/tools`, { headers });
  if (!res.ok) throw new Error(`cannot reach the remote service: GET ${base}/api/tools → ${res.status}`);
  const { tools } = (await res.json()) as { tools: RemoteToolDef[] };
  log(`remote mode: proxying ${tools.length} tools from ${base}`);

  const registry = createMCPToolRegistry();
  for (const def of tools) {
    registry.register({
      name: def.name,
      description: `${def.description} (served remotely from ${base})`,
      inputSchema: def.inputSchema,
      execute: async (input): Promise<MCPToolResultValue> => {
        try {
          const call = await fetch(`${base}/api/tools/${def.name}`, {
            method: "POST",
            headers,
            body: JSON.stringify(input ?? {}),
          });
          if (!call.ok) return MCPToolResult.failure(`remote call failed: HTTP ${call.status}`);
          return (await call.json()) as MCPToolResultValue;
        } catch (e) {
          return MCPToolResult.failure(`remote call failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    });
  }

  const server = createMCPServer({
    registry,
    serverInfo: SERVER_INFO,
    instructions: SERVER_INSTRUCTIONS,
    log: (level, msg) => log(`[mcp:${level}] ${msg}`),
  });
  await serveStdio(server);
}

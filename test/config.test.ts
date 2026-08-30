import { describe, expect, it } from "vitest";
import {
  loadConfig,
  RATE_LIMIT_MS,
  USER_AGENT,
  FETCH_MAX_RETRIES,
} from "../src/config.js";

describe("operating constraints", () => {
  it("keeps the global rate limit at one request per second or slower", () => {
    expect(RATE_LIMIT_MS).toBeGreaterThanOrEqual(1000);
  });

  it("identifies itself honestly", () => {
    expect(USER_AGENT).toMatch(/^korter-mcp\/\d+\.\d+ \(personal research tool\)$/);
  });

  it("keeps retries bounded", () => {
    expect(FETCH_MAX_RETRIES).toBeLessThanOrEqual(3);
  });
});

describe("loadConfig", () => {
  it("defaults to stdio", () => {
    expect(loadConfig([], {}).mode).toBe("stdio");
  });

  it("rejects an unknown mode", () => {
    expect(() => loadConfig(["daemon"], {})).toThrow(/unknown mode/);
  });

  it("requires a remote URL in remote mode", () => {
    expect(() => loadConfig(["stdio"], { KORTER_MODE: "remote" })).toThrow(
      /KORTER_REMOTE_URL/,
    );
  });

  it("carries the remote base URL through", () => {
    const config = loadConfig(["stdio"], {
      KORTER_MODE: "remote",
      KORTER_REMOTE_URL: "https://korter.example.com",
    });
    expect(config.korterMode).toBe("remote");
    expect(config.remoteBaseUrl).toBe("https://korter.example.com");
  });
});

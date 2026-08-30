/**
 * robots.txt parsing and checking (CLAUDE.md hard rule 6). Pure functions —
 * fetching the file goes through the same paced client as everything else.
 *
 * Semantics: User-agent group matching for `*` and for our token; longest-match
 * precedence between Allow and Disallow; `*` wildcard and `$` anchor supported.
 * Nothing korter's current file needs beyond prefixes, but rule files change.
 */

export interface RobotsRules {
  /** [directive, pattern] pairs from the groups that apply to us. */
  rules: { allow: boolean; pattern: string }[];
}

const OUR_TOKEN = "korter-mcp";

export function parseRobots(txt: string): RobotsRules {
  const rules: RobotsRules["rules"] = [];
  let applies = false;
  let inGroupHeader = false;

  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();

    if (field === "user-agent") {
      const matches = value === "*" || value.toLowerCase().includes(OUR_TOKEN);
      applies = inGroupHeader ? applies || matches : matches;
      inGroupHeader = true;
      continue;
    }
    inGroupHeader = false;
    if (!applies) continue;
    if (field === "disallow" || field === "allow") {
      if (value) rules.push({ allow: field === "allow", pattern: value });
      // An empty Disallow means "everything allowed" — no rule needed.
    }
  }
  return { rules };
}

export function isAllowed(rules: RobotsRules, path: string): boolean {
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of rules.rules) {
    if (matches(rule.pattern, path)) {
      const length = rule.pattern.length;
      if (!best || length > best.length || (length === best.length && rule.allow && !best.allow)) {
        best = { allow: rule.allow, length };
      }
    }
  }
  return best ? best.allow : true;
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const parts = body.split("*").map(escapeRegExp);
  const re = new RegExp(`^${parts.join(".*")}${anchored ? "$" : ""}`);
  return re.test(path);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

# korter-mcp

Event-sourced [korter.ge](https://korter.ge) proxy exposed as MCP tools.
Tbilisi new-builds, with **price history** — korter shows you a price, this
shows you how it moved.

Built on [`@lambda-house/teob-ts`](https://github.com/lambda-house/teob-ts).
Personal research tool. Not a product, not a data service.

## Registering in Claude Code

Local stdio server (fetches korter itself, keeps its own history):

```bash
pnpm install && pnpm run build
claude mcp add --transport stdio korter -- node /path/to/korter-mcp/dist/main.js stdio
```

Project-scoped: this repo ships [`.mcp.json`](.mcp.json), so a Claude Code
session opened in this directory has the server automatically.

Remote (a deployed `serve` instance does the fetching; one shared history, no
duplicate load on korter):

```bash
# MCP over Streamable HTTP (put an OAuth-capable gateway in front — see Modes):
claude mcp add --transport http korter https://<your-host>/mcp

# or the stdio facade over the deployed read API:
KORTER_MODE=remote \
KORTER_REMOTE_URL=https://<your-host> \
KORTER_REMOTE_TOKEN=<api token> \
  claude mcp add --transport stdio korter -- node /path/to/korter-mcp/dist/main.js stdio
```

Once connected, call the `get_skill` tool (`apartment-search`,
`criteria-coverage`, `freshness-and-history`, `operating-limits`) — the server
ships its own usage guidance.

## Tools

Reads (served from projections and the journal — never from a live fetch):
`search_projects`, `get_project`, `list_districts`, `price_history`,
`diff_report`.

Commands: `refresh` (fetch a source now — refreshing is an action, not a
`force` flag on reads), `track` / `untrack` / `list_tracked` (the weekly sweep
set, journaled).

Source ids are `project:<slug>` or `listing:<slug>`, e.g.
`project:tsavkisi-park-tbilisi`, `listing:new-projects-in-avlabari`.

**Every result carries the envelope**: `source_url`, `fetched_at`,
`prices_as_of` (korter's own "prices up to date as of" date — null when korter
shows none), `observed_at`, `staleness_days`. All timestamps come from journal
events, never from the clock at serialization time; `staleness_days` is the
one field allowed to consult the clock, because "how stale is this now" is a
question about now.

## Why event sourcing for a scraper

Two reasons, and if either stopped being true a `sqlite3` + `httpx` script would
be the better tool:

1. **Price history is an event log.** `PriceObserved` on a `Project` entity *is*
   the history — no `price_history` table, no INSERT-if-changed rule. Dedup is a
   pure `decide` function returning `done()`.
2. **The same code runs two ways** — a local stdio MCP server on a laptop, and a
   long-lived prod service whose history keeps accruing whether or not the
   laptop is on.

## Design

Three aggregates:

| Aggregate | Per | Holds |
|---|---|---|
| `Project` | korter slug | attributes and the price history |
| `Source` | fetched URL | fetch lifecycle, listing membership |
| `Tracker` | singleton | the tracked set and the sweep schedule |

Raw HTML is *not* event-sourced — it lives in a plain 24h `page_cache` table,
with `sourceHash` on the events tying an observation back to its bytes. The
same goes for korter's district taxonomy: reference data in a plain table,
refreshed by listing fetches, not history.

Recon findings and the extraction map: [`docs/schema-notes.md`](docs/schema-notes.md).

### Storage

SQLite everywhere, including a deployed instance (on a persistent volume).
teob-ts's whole read model — projection store, live category tails, journal
reader — is SQLite-native, and this corpus is a handful of entities with
weekly writes. Postgres would be an unused dependency.

### Fixtures

`fixtures/` holds saved korter pages for parser-compatibility tests. They are
korter's content and are **not distributed** — absent (as in the public
snapshot), those tests skip and the suite still passes against the invented
pages in `test/synthetic.ts`. See [`fixtures/README.md`](fixtures/README.md).

## Modes

```bash
node dist/main.js stdio   # MCP over stdin/stdout (default; stdout carries frames, logs go to stderr)
node dist/main.js serve   # long-lived service: /api + /mcp on :8080, probes on :9095
node dist/main.js sweep   # one-shot sweep of the tracked set, prints the diff report, exits
pnpm run smoke            # 2 live requests against korter, excluded from CI
```

`serve` refuses to start without `KORTER_API_TOKEN` and
`KORTER_POMERIUM_TOKEN` — the endpoints must be authenticated, or a personal
research tool becomes a public scraper fronting someone else's site.

## Development

```bash
pnpm install
pnpm test               # zero network — everything runs against fixtures/
pnpm run typecheck
pnpm run build
```

## How it behaves toward korter

- **1 request/second**, globally, across every caller. Cache-first, 24h TTL.
  Weekly sweeps of a short tracked list.
- **Honest User-Agent**: `korter-mcp/0.1 (personal research tool)`.
- **403 or 429 stops the tool.** The breaker opens and stays open. Nothing
  rotates, nothing retries behind your back, nothing gets bypassed.
- Listing and project pages only — no secondary market, no user listings.
- No republication, no resale, no bulk export.
- `robots.txt` is checked before fetching (and korter's disallows their own
  hydration API — so only the HTML pages are read, never `/api/`).

These constraints live in `src/config.ts` and are asserted by the test suite.

## Known limitations

- **korter's own data goes stale.** Cards dated June 2025 were still displayed
  in August 2026 (the smoke run on 2026-08-30 found a live card 39 days stale).
  Read `prices_as_of` and `staleness_days`.
- **The parser is the fragile part.** One pure function, `src/parse/extract.ts`,
  reading `window.INITIAL_STATE`; fully fixture-tested. It will break when
  korter redesigns, and everything else is deliberately independent of it.
- **Districts are korter's taxonomy.** Their "Vake district" swallows Bagebi,
  Lisi and the Nutsubidze plateau. No mapping to colloquial neighbourhoods is
  invented.
- **Prices come in the page currency** (`/en/` serves USD). GEL and USD are
  independent series, never converted.
- **A page's currency history starts when this tool first observes it** — there
  is no backfill; korter shows no history to backfill from. That asymmetry is
  the reason this tool exists.
- korter's ToS likely prohibits automated extraction. The operator accepts that
  risk knowingly and keeps volume trivial in exchange. If you run this
  yourself, that trade-off — and the structural limits that keep it honest —
  becomes yours.

## License

[Apache-2.0](LICENSE).

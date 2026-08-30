/**
 * Skills as tools: curated usage guidance the model fetches at runtime via the
 * get_skill tool. Tool descriptions stay short; the deep "how do I map a
 * user's apartment criteria onto this server" knowledge lives here, versioned
 * with the code that implements it.
 */

export interface Skill {
  name: string;
  summary: string;
  body: string;
}

export const SKILLS: readonly Skill[] = [
  {
    name: "apartment-search",
    summary: "Map a buyer's criteria onto the search tools; the coarse-to-fine flow",
    body: `# Answering an apartment-search query

## Flow: coarse → fine

1. **District known?** refresh the district listing once
   (\`refresh\` with \`listing:new-projects-tbilisi-<district>-district\` or a
   microdistrict listing like \`listing:new-projects-in-avlabari\`) — one paced
   fetch observes every project card in the district.
2. **Filter at card level** with \`search_projects\`: district, city,
   min/max_price_per_m2, max_budget, construction_status, building_type,
   developer, q.
3. **Rooms/area criteria** need per-unit data, which only project pages carry.
   \`search_projects\` returns \`needs_unit_data\` — the slugs that pass every
   card-level filter but lack unit data. Refresh a SHORTLIST of those
   (\`refresh\` with \`project:<slug>\`, at most ~10 — each is a real korter
   request at 1 req/s), then run the same search again: the rooms/area filters
   now apply.
4. Present results with \`price_per_m2\`, \`price_from\`, \`rooms_available\`,
   \`area_range_m2\`, and ALWAYS \`staleness_days\` + \`prices_as_of\`.

## Criteria mapping

| User says | Tool argument |
|---|---|
| "in Vake / Saburtalo / …" | district (korter's taxonomy — their "Vake" includes Bagebi, Lisi, Nutsubidze plateau; say so if it matters) |
| "up to X per m²" | max_price_per_m2 (+ currency) |
| "budget X total" | max_budget |
| "2-room / 3-room" | rooms (exact) or min_rooms |
| "80–120 m²" | min_area_m2 + max_area_m2 (matches any unit type whose range overlaps) |
| "ready / under construction" | construction_status: "ready" \| "construction" |
| "townhouse / cottage" | building_type: "cottage" |
| "from developer X" | developer |
| "near <place>" | not filterable — results carry lat/lng; compute distance yourself |

## Currency

All /en/ data is **USD**. Never convert. If the user's number is ambiguous
("до 4000 за метр"), ask which currency; if they mean GEL, tell them the data
is USD and convert THEIR bound only with their consent, never the data.

## Secondary market (resale + rent)

\`search_secondary\` searches the CURRENT snapshot of resale/rent listings
(section: "sale" | "rent"; rent prices are per month). Criteria: district,
rooms, area, max_price, max_price_per_m2, property_type. Each result carries
the korter listing URL — contacting the seller happens THERE; this server
stores property facts only. Snapshots come from \`secondary:<slug>\` sources
the operator tracks; if a filter has no snapshot, the result names the exact
source to refresh. \`secondary_trends\` gives per-district aggregates (avg
$/m², sale + rent ranges) and their accrued trend. Per-listing korter
freshness is \`actualize_staleness_days\` — surface it.

## What not to promise

Floor plans/views, mortgage terms, POI distances (schools/metro), completion
quarter — not modeled (see criteria-coverage). Seller identities are never
stored or served — only the korter link.`,
  },
  {
    name: "criteria-coverage",
    summary: "What korter exposes vs what this server models — the gap map by buyer persona",
    body: `# Criteria coverage: possible now, possible after refresh, extractable, out of scope

## Supported at card level (any observed project)
district/city (korter taxonomy), price_per_m2 + price_from per currency,
construction_status, sales_status, building_type, developer, name/address text,
coordinates (lat/lng — radius math is yours), delisted, full price history.

## Supported once the project page is observed (refresh project:<slug>)
rooms (per unit type), unit area ranges, per-unit price ranges, all_sold per
unit type, renovation/finish state (e.g. "green frame").

## In korter's page state but NOT yet modeled (extractable if needed)
- completion timeline: houses/queues with end dates → "ready by 2027" queries
- purchaseOffers → installment/mortgage-from-developer filters
- attributes list (construction technology, floors count, ceiling height)
- subway links (present on some pages)
- korter's own prevMinPriceSqm (their memory of the previous price)

## Not available from korter's pages (do not promise)
floor-level unit availability, view/orientation, HOA fees, energy certs,
school/POI data, developer reputation scores, actual sales prices.

## Secondary market (since 2026-08-30)
Current snapshots per tracked \`secondary:\` source: resale and rent listings
(price, rooms, area, floor/floors, district, coordinates, korter's own
actualize date, link to the listing) + per-district aggregates and their
journaled trend. NOT kept: per-listing history (ephemeral — the trend is
journaled at district level) and seller identities (never read from the page;
buyers use the korter link).

## Out of scope (never fetched or stored)
individual sellers' contacts/identities, korter's /api endpoints
(robots.txt-disallowed — HTML pages only).

## Persona clusters and how they map

| Persona | Criteria cluster | Verdict |
|---|---|---|
| Young professional | 1–2 rooms, 40–60m², ≤$120k, Vake/Saburtalo, near-ready | full support after shortlist refresh |
| Family upsizer | 3+ rooms, 90–130m², ready, quieter district | full support; "quiet" = your judgment on district/coords |
| Yield investor | cheapest $/m², small units, price TREND | the trend is this tool's unique value (price_history, diff_report); yield itself needs rent data — out of scope |
| Remote/diaspora buyer | USD budget, trusted developer, delivery date | budget+developer yes; delivery date = extractable gap (queues) |
| Luxury seeker | high-end Vake/Mtatsminda, finish quality | price/district/renovation yes; "premium" flag is korter PAID PLACEMENT, not quality — never present it as quality |
| First-home budget | ≤$60–70k total, any district, installments | max_budget yes; installments = extractable gap (purchaseOffers) |
| Cottage family | townhouse/cottage, Tsavkisi/Okrokana | building_type + city — full support |
| Downsizing senior | small ready unit, low floor, elevator | rooms/area/ready yes; floor/elevator not available |
| Short-horizon nomad | studio, completing soon, new district | rooms yes; "completing soon" = extractable gap (queues) |
| Quality-focused | construction tech, finish state | renovation yes; construction technology = extractable gap (attributes) |

When a persona hits an "extractable gap", say what is missing and that it can
be added; when it hits "not available" or "out of scope", say so plainly.`,
  },
  {
    name: "freshness-and-history",
    summary: "Reading the staleness envelope; using price_history and diff_report",
    body: `# Freshness and history

Every result carries: source_url, fetched_at (when we read the page),
prices_as_of (korter's OWN "prices updated" date — null on listing-card data),
observed_at, staleness_days (days since prices_as_of, or since fetch when
korter shows no date).

- staleness_days counts korter's staleness, not this tool's. A refresh can
  return staleness_days=39 — that means korter itself last updated the price
  39 days ago. Always surface this; korter presents such prices as current.
- Reads NEVER fetch. Data is as fresh as the last refresh/sweep (weekly sweep
  of the tracked set; anything else on demand via refresh, cache-first 24h).
- price_history(slug): every price change + re-dating observed, per currency,
  from the journal. History starts at first observation — there is no
  backfill, because korter shows none. Depth grows weekly.
- diff_report(since): price moves old→new, discoveries, delistings, and
  listing membership changes (projects appearing/disappearing per district)
  across everything observed.
- track(source_id) adds a listing or project to the weekly sweep so its
  history accrues without anyone asking.`,
  },
  {
    name: "operating-limits",
    summary: "Rate limits, the breaker, and what this tool refuses to do",
    body: `# Operating limits (structural, not configurable)

- 1 request/second to korter globally, all callers combined; 24h page cache;
  honest User-Agent. A "search session" should refresh at most ~10 project
  pages — prefer narrowing card-level filters first.
- If korter answers 403/429 the circuit breaker OPENS AND STAYS OPEN. Tools
  report it; nothing retries or evades. Tell the user to try much later.
- No bulk export, no corpus dumps, no seller contacts or identities (secondary
  listings are served as property facts + the korter link), no korter /api
  endpoints (their robots.txt disallows them; only public HTML pages are read).
- End users never trigger korter fetches — searches are served from collected
  data, so korter load is independent of user count. Fetching (refresh/track)
  is operator-only on the hosted endpoint.
- Currencies are never converted; korter's district taxonomy is returned
  as-is.`,
  },
  {
    name: "privacy",
    summary: "The privacy notice shown to authenticated users (current version)",
    body: `# Privacy notice — korter-mcp (version 2026-08-30.1)

**Who**: korter-mcp, a real-estate MCP service for the Georgian market,
operated by Lambda House. Data source: publicly listed offers on korter.ge.

**What we process about you** (signed-in users):
- Identity from your sign-in provider: subject id, email, display name.
- Your consent decisions (kind, notice version, timestamp — kept as an
  auditable log).
- Your search interests: the criteria you state (district, budget, rooms,
  area, section) — never free text, never your results.

**Why**:
- To provide the tools (requires accepting this notice: consent
  accept_terms=true).
- If — and only if — you separately opt in (marketing_offers=true): to send
  you real-estate suggestions matching your recorded interests. This opt-in
  is OPTIONAL and never a condition of using the tools.

**Your controls**:
- my_data — see everything held about you, including the full consent log.
- consent with accept_terms=false or marketing_offers=false — revoke at any
  time; revocations are recorded in the same auditable log.

**What we do NOT do**: no sale of your data, no third-party sharing, no
tracking beyond the stated interests, and no storage of property sellers'
identities (listings link to korter, where sellers chose to publish).

Questions: the operator (Lambda House).`,
  },
];

export function getSkill(name: string): Skill | undefined {
  return SKILLS.find((s) => s.name === name);
}

export function skillIndex(): string {
  return SKILLS.map((s) => `${s.name} — ${s.summary}`).join("; ");
}

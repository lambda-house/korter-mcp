# korter page schema notes

Phase 0 deliverable. Sources: `fixtures/*.html`, fetched 2026-08-30 with UA
`korter-mcp/0.1 (personal research tool)`, 3 requests ≥1.5s apart, all HTTP 200.

## Stack

- **React SSR + serialized stores**, not Next.js. One inline `<script>` sets
  `window.serverUrl = "building/geo"` and `window.INITIAL_STATE = {...};` —
  a single JSON object (~70KB) holding everything the page renders.
  Loadable-components chunk manifest (`__LOADABLE_REQUIRED_CHUNKS___ext`) names
  the route: `buildingListing` (listing pages) / `buildingLanding` (project
  pages). Consistent with a Flatfy/LUN property; assets on
  `storage.googleapis.com/bd-ge-01/`.
- **Extraction strategy:** slice `window.INITIAL_STATE = ` → matching `{...}`
  (JSON.parse of the balanced object; `raw_decode`-style, do not regex to the
  last `}`), then read typed paths. No CSS selectors needed for any core field.
  HTML selectors are the fallback only if korter stops inlining state.
- `ld+json` (`Product` with `AggregateOffer`) confirms currency and price range
  but is **not** the primary source (fewer fields, string prices).
- The frontend hydrates via `/api/`, `/building/geo` etc. — **all disallowed by
  robots.txt**. We never call them; HTML pages only. `window.INITIAL_STATE` is
  served in the page itself, so one HTML fetch = one complete observation.

## Store shapes

Top-level keys (both page types): `userStore`, `favoritesStore`,
`navigationStore`, `uiStore`, `seoStore`, `currencyStore`, `leadStore`,
`contactsStore`, `mapStore`, plus **one of**:

- listing pages → `buildingListingStore`
- project pages → `buildingLandingStore`

That discriminates the page type reliably.

### `currencyStore` (both)

```json
{ "rate": 2.61018, "inverseRate": 0.383115, "currency": "USD", "areaUnit": "m" }
```

**One currency per page.** `/en/` pages serve USD; GEL is a locale/cookie
variant we do not fetch. So each observation carries exactly one currency —
`PriceObserved` stays keyed by `currency` as designed, there is just one per
fetch in practice. `rate` is GEL-per-USD; **never use it** (hard rule: no
conversion). Read the currency from `currencyStore.currency` (`"USD"`/`"GEL"`),
not from the `'$'`/`'₾'` sigil in `main.currency`.

## Extraction map

### Listing page → `buildingListingStore`

| Field | JSON path | Notes |
|---|---|---|
| cards | `buildings[]` | 11 for avlabari; `filtersStore.totalCount` matches |
| slug | `buildings[].url` | `"/en/10-vakhtang-vi-street-tbilisi"` → strip `/en/` |
| korter id | `buildings[].buildingId` | numeric, stable — keep as attribute |
| name | `buildings[].name` | always present |
| price from | `buildings[].minPrice` | number, page currency; `0`/`null` possible (seen `price: 0` on related cards) |
| price per m² | `buildings[].minPriceSqm` | number |
| address | `buildings[].address` | present on cards |
| district | `buildings[].subLocalityNominative` | plain string, e.g. `"Isani"` |
| city | `buildings[].mainGeoObject.name` | `{id: 1, name: "Tbilisi"}` |
| lat/lng | `buildings[].location.{lat,lng}` | |
| developer | `buildings[].developers[0].name` | `{developerId, name, link}` |
| construction status | `buildings[].constructionStatus` | `"construction"`, … |
| sales status | `buildings[].salesStatus` | `"available"`, … |
| `prices_as_of` | — | **absent on listing cards** → `pricesAsOf: null` |
| district taxonomy | `filtersStore.geoObjects.mainGeoObject` + `.childrenGeoObjects[]` | `{geoObjectId, nominative, category: "city"\|"district"\|"microdistrict", link, childrenGeoObjects[]}` — korter's taxonomy verbatim |
| district avg prices | `geoObjectsAvgPrices.primaryGeoObjects.geoObjects[]` | `{geoObjectId, nominative, averagePrice, buildingListingLink}` |

### Project page → `buildingLandingStore`

| Field | JSON path | Notes |
|---|---|---|
| korter id | `buildingId` | top of store |
| name | `main.name` (also `main.nameOrAddress`) | always present |
| price from | `main.minPrice` | number, page currency |
| price per m² | `main.minPriceSqm` | number |
| korter's own prev price | `main.prevMinPriceSqm` | their memory, not ours — attribute at most |
| **`prices_as_of`** | `main.pricesUpdateTime` | ISO 8601 with offset, e.g. `"2026-07-22T04:12:53+00:00"`. Fixture fetched 2026-08-30 → already 39 days stale. **The whole point of this tool, confirmed in the wild.** |
| currency sigil | `main.currency` | `"$"` — prefer `currencyStore.currency` |
| address | `main.address` | **nullable** (tsavkisi: `null`) |
| district | `main.subLocality.{geoObjectId, nominative, buildingListingLink}` | object here, string on cards |
| city-ish geo | `main.mainGeoObjectNominative` | for tsavkisi this is `"Tsavkisi"`, not Tbilisi — settlement, not city |
| developer | `main.developers[0]` | `{developer_id, name, link}` — snake_case here, camelCase on cards |
| lat/lng | `map.{lat,lng}` | plus `map.polygon[]` |
| construction status | `main.constructionStatus` | |
| sales status | `main.salesStatus` | |
| building type | `main.buildingType` | `"cottage"`, … |
| delisted flag | `main.isDeleted` | boolean |
| unit types | `prices.unitTypes[]` | `{unitTypeName, propertyType, roomCount, price: {minPrice, maxPrice}, area: {minArea, maxArea}, minPriceSqm, allSold}` |
| attributes | `attributes.house[]` / `attributes.flat[]` | `{name, value}` pairs |
| documents | `documents` | nullable |

## Mapping onto `ProjectEvent` (BRIEF §3)

Fits with three amendments, all pre-first-write:

1. **`AttributesObserved` gains optional fields**: `city?`,
   `constructionStatus?`, `salesStatus?`, `buildingType?`, `korterId?` — all
   observed, all attribute-like, all cheap to add now vs upcast later.
2. **`PriceObserved` fits exactly**: `priceFrom` ← `minPrice`, `pricePerM2` ←
   `minPriceSqm`, `currency` ← `currencyStore.currency`, `pricesAsOf` ←
   `main.pricesUpdateTime` (project pages) / `null` (listing cards).
3. **`pricesAsOf: null` means unknown, not "no date".** Listing and project
   observations interleave for the same slug. Dedup rule refinement:
   - identical price + identical known `pricesAsOf` → `done()`
   - identical price + new `pricesAsOf` (non-null, different) → `StalenessObserved`
   - `pricesAsOf: null` never overwrites a known date and never triggers
     `StalenessObserved` — otherwise listing/project alternation ping-pongs events.

Presence matrix: always present — slug/url, name, buildingId,
constructionStatus, salesStatus; optional — address (null on project pages
sometimes), minPrice (can be 0 → treat as null), pricesUpdateTime (project
pages only), developer (assume list may be empty), coordinates (assume
optional). Listing cards carry **no** `pricesUpdateTime` and a string district;
project pages carry the full geo object and unit-type breakdown.

## robots.txt

- Checked: 2026-08-30, saved as `fixtures/robots.txt`.
- Disallowed (User-agent `*`): `/redirect`, `/building/geo`, `/api/`, `/pyapi/`,
  `/node-api/`, `/fpm-status/`, `/email/`, `/get-email-html/`,
  `/post-email-html/`, `/*construction-photo-id=`, `*/amp/`.
- Paths we use (`/en/new-projects-*`, `/en/<project-slug>`, `/robots.txt`):
  **allowed**.
- Verdict: **proceed**, HTML pages only; the disallow on `/api/` & co. is a
  hard boundary — no hydration-endpoint calls ever, even though the browser
  makes them.

## Fixtures

| File | Type | Store |
|---|---|---|
| `new-projects-in-avlabari.html` | listing (microdistrict) | `buildingListingStore`, 11 cards |
| `new-projects-tbilisi-vake-district.html` | listing (district) | `buildingListingStore` |
| `tsavkisi-park-tbilisi.html` | project | `buildingLandingStore` |
| `robots.txt` | — | — |

## Secondary-market pages (added 2026-08-30)

`apartmentListingStore` on `/en/apartments-sale-…` and `/en/apartments-for-rent-…`:

| Field | JSON path | Notes |
|---|---|---|
| cards | `apartments[]` | ~20/page; `filtersStore.totalCount` = full filter count |
| listing id | `apartments[].objectId` | numeric |
| seller id | `apartments[].userId` | **present on the page, deliberately never read** — hard rule 2 |
| korter link | `apartments[].link` | the contact path — buyers go there |
| price | `apartments[].price` + `currency` | sale = total; rent = per month |
| area / rooms | `area`, `roomCount` | `propertyType` ("flat"/"studio"), `propertyCategory` |
| floor | `floorNumbers[0]` / `house.floorCount` | |
| building | `building.{name,address,link,position}` | links secondary units to new-build projects |
| district | `subLocalityNominative` | |
| per-listing freshness | `actualizeTime` | ISO — korter's own actualization date |
| focus district | `filtersStore.routeParams.geo_object_id` | |
| aggregates | `geoObjectsAvgPrices.primaryGeoObjects.geoObjects[]` | `averagePrice` ($/m² secondary), `min/maxLayoutsPrice` (sale), `min/maxLayoutsRentPrice` (monthly), sale/rent listing links per district |

Fixtures: `apartments-sale-tbilisi-vake-district.html`, `apartments-for-rent-tbilisi-vake.html`.

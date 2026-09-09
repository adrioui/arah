# arah

Map-first ride planner for Indonesian cycling. Point-to-point go rides
only. Live routers rank first, curated GPX second, a straight line last.
Every verdict cites its evidence. Unknowns stay unknown.

Overlays degrade, identity errors escape. Flood, closure, and weather
layers isolate, zoom, and pop up with note plus time plus source.
Riders export GPX, share plan links, and ride offline.

## Run

```sh
pnpm install
pnpm dev
```

The server listens on `PORT` (default `8790`). Open `http://127.0.0.1:8790`
for the UI, `/docs` for the Scalar API reference, `/openapi.json` for the
spec. Port `8787` is not arah (another local app uses it). For Foldkit
hot-reload, use `pnpm dev:hot` and open `http://127.0.0.1:5173`.

Live PetaBencana flood intake (Jakarta) is behind a flag and falls back to
fixtures on any failure:

```sh
ARAH_LIVE=1 pnpm dev
```

## Checks

```sh
pnpm typecheck
pnpm lint
pnpm test
```

Lint runs Oxlint with the vendored-behavior `oxlint-plugin-anti-slop`
ruleset (patched via `patches/`): no `unknown` params or returns, no runtime
`typeof` narrowing, no bare assertions, no module mocks, and no
`make<Service>` constructor imports in runtime code.

## Endpoints

`POST /api/decide` ranks live plus curated candidates for a go request.
`POST /api/intend` parses free text into a go request, then decides.
`GET /api/health` reports feed provenance, place count, and snapshot id.
`GET /api/places?q=` autocompletes registry plus geocoded places.
`POST /api/feedback` appends a rider report to `data/feedback.jsonl`.
`GET /tiles/*` serves operator-dropped offline tile archives.

GPX export, share links, elevation profiles, and the reach ring need no
new endpoints. The client builds GPX and share URLs from decisions.
Elevation samples attach to ranked rows. The ring ships inside decisions.

## Layout

`src/domain.ts` owns the Schema models and branded ids.
`src/decide.ts` owns the pure deterministic decision.
`src/fit.ts` owns go ranking with hill plus lighting plus lane preferences.
`src/elevation.ts` owns Terrarium sampling with a minimal PNG decoder.
`src/isochrone.ts` owns the ORS polygon with a planning ring fallback.
`src/api/Api.ts` owns the schema-first HttpApi definition.
`src/handlers.ts` owns the endpoint handlers with a NoDeps export.
`src/server.ts` and `src/main.ts` own route composition and the entrypoint.
`data/` owns curated routes, fixture observations, and rider feedback.
`data/tiles/` holds operator-dropped offline archives for `/tiles/`.
`web/` owns the Foldkit UI (`pnpm build:web` writes `web/dist/`).
`web/src/gpx.ts` builds GPX tracks client-side from decisions.
`web/src/share.ts` encodes and parses shareable plan links.

## Open decisions

Go routing is a ladder. GraphHopper runs first, OSRM second, curated GPX
third, and a straight line last. ORS isochrones run when `ARAH_ORS_URL`
points at a self-hosted instance, otherwise a labeled planning ring ships.
BMKG live parsing is unwritten, fixtures carry the weather signal.
Feedback is a local append-only file, not a moderated queue.

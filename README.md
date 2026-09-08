# arah

Pre-ride safety checks for Indonesian cycling routes. Curated candidates are
checked against flood, weather, and closure reports. Every verdict cites its
evidence. Unknowns stay unknown.

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

`POST /api/decide` ranks the curated candidates for a train or go request.
`GET /api/health` reports feed provenance and the map snapshot id.
`GET /api/routes` serves curated route geometries for the map.
`POST /api/feedback` appends a rider report to `data/feedback.jsonl`.

## Layout

`src/domain.ts` owns the Schema models and branded ids.
`src/decide.ts` owns the pure deterministic decision.
`src/api/Api.ts` owns the schema-first HttpApi definition.
`src/handlers.ts` owns the endpoint handlers with a NoDeps export.
`src/server.ts` and `src/main.ts` own route composition and the entrypoint.
`data/` owns curated routes, fixture observations, and rider feedback.
`web/` owns the Foldkit UI (`pnpm build:web` writes `web/dist/`).

## Open decisions

Go routing is a ladder. GraphHopper runs first, OSRM second, curated GPX
third, and a straight line last. BMKG live parsing is unwritten, fixtures
carry the weather signal. Feedback is a local append-only file, not a
moderated queue.

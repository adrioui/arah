# arah

Pre-ride safety checks for Indonesian cycling routes. Curated candidates are
checked against flood, weather, and closure reports. Every verdict cites its
evidence. Unknowns stay unknown.

## Run

```sh
pnpm install
pnpm dev
```

The server listens on `PORT` (default `8787`). Open `http://localhost:8787`
for the UI, `/docs` for the Scalar API reference, `/openapi.json` for the
spec.

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
`src/catalog.ts` and `src/observations.ts` own the Layer services.
`src/handlers.ts` owns the endpoint handlers with a NoDeps export.
`src/server.ts` and `src/main.ts` own route composition and the entrypoint.
`data/` owns curated routes, fixture observations, and rider feedback.
`public/` owns the static UI. No build step and no external requests.

## Open decisions

Router is curated GPX, not a live engine. GraphHopper stays outside the
Worker-shaped future deploy. BMKG live parsing is unwritten, fixtures carry
the weather signal. Feedback is a local append-only file, not a moderated
queue.

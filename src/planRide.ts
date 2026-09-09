import { Clock, Context, Effect, Layer, Schema } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import {
  CoverageEntry,
  type DecisionOutput,
  type GeoPoint,
  type Observation,
  type ResolvedPlace,
  type RouteRequest,
} from "./domain.js";
import { decide } from "./decide.js";
import { resolveIsochrone } from "./isochrone.js";
import { sampleRouteElevation } from "./elevation.js";
import { rankGoRoutes, rankOptionsFrom } from "./fit.js";
import { ObservationState, fetchFlood, fetchNowcast } from "./observations.js";
import { PlaceNotFound, PlaceResolver } from "./placeResolve.js";
import { Places } from "./places.js";
import {
  defaultDepartAt,
  IntentionDraft,
  IntentionUnreadable,
  parseIntentionWithTables,
} from "./parseIntention.js";
import { goCandidates, GraphHopperConfig } from "./router.js";
import { RouteCatalog, RouterUnavailable } from "./routeCatalog.js";

function isLiveWeather(): boolean {
  return (process.env["ARAH_LIVE"] ?? "0") === "1";
}

/** Leave time far enough in the future that a real forecast would be required. */
const SCHEDULED_DEPARTURE_TOLERANCE_MS = 5 * 60 * 1000;

export class InvalidDepartAt extends Schema.TaggedError<InvalidDepartAt>()(
  "InvalidDepartAt",
  { detail: Schema.String },
  { httpApiStatus: 422 },
) {}

/** Validate a departure timestamp and return its epoch milliseconds. */
function departureTimestamp(departAt: string, nowMs: number): number {
  const departMs = Date.parse(departAt);
  if (
    Number.isNaN(departMs) ||
    departMs > nowMs + SCHEDULED_DEPARTURE_TOLERANCE_MS
  ) {
    return Number.NaN;
  }
  return departMs;
}

function focusPointFor(
  origin: ResolvedPlace,
  destination: ResolvedPlace,
): GeoPoint {
  return destination?.point ?? origin.point;
}

function routeExtent(
  routes: ReadonlyArray<{ readonly points: ReadonlyArray<GeoPoint> }>,
  fallback: GeoPoint,
): Array<GeoPoint> {
  const points = routes.flatMap((route) => [...route.points]);
  if (points.length === 0) {
    return bboxAround(fallback, 0.02);
  }
  let minLat = points[0]!.lat;
  let maxLat = points[0]!.lat;
  let minLon = points[0]!.lon;
  let maxLon = points[0]!.lon;
  for (const point of points) {
    minLat = Math.min(minLat, point.lat);
    maxLat = Math.max(maxLat, point.lat);
    minLon = Math.min(minLon, point.lon);
    maxLon = Math.max(maxLon, point.lon);
  }
  const pad = 0.02;
  return [
    { lat: maxLat + pad, lon: minLon - pad },
    { lat: maxLat + pad, lon: maxLon + pad },
    { lat: minLat - pad, lon: maxLon + pad },
    { lat: minLat - pad, lon: minLon - pad },
  ];
}

function bboxAround(point: GeoPoint, radiusDeg: number): Array<GeoPoint> {
  return [
    { lat: point.lat + radiusDeg, lon: point.lon - radiusDeg },
    { lat: point.lat + radiusDeg, lon: point.lon + radiusDeg },
    { lat: point.lat - radiusDeg, lon: point.lon + radiusDeg },
    { lat: point.lat - radiusDeg, lon: point.lon - radiusDeg },
  ];
}

interface LiveWeather {
  readonly observations: ReadonlyArray<Observation>;
  readonly coverages: ReadonlyArray<CoverageEntry>;
}

const emptyCoverages: ReadonlyArray<CoverageEntry> = [];

function fetchLiveWeather(
  nowMs: number,
  focus: GeoPoint,
  extent: Array<GeoPoint>,
): Effect.Effect<LiveWeather, never, HttpClient.HttpClient> {
  if (isLiveWeather() === false) {
    return Effect.succeed({ observations: [], coverages: emptyCoverages });
  }
  const nowcast = fetchNowcast(focus, nowMs).pipe(
    Effect.map((observation) => ({
      observations: [observation],
      coverages: [
        {
          source: "nowcast" as const,
          polygon: observation.polygon,
          state: "covered" as const,
        },
      ],
    })),
    Effect.catchTag("NowcastUnavailable", () =>
      Effect.succeed({
        observations: [],
        coverages: [
          {
            source: "nowcast" as const,
            polygon: extent,
            state: "unavailable" as const,
          },
        ],
      }),
    ),
  );
  const flood = fetchFlood(nowMs).pipe(
    Effect.map((observations) => ({
      observations,
      coverages: emptyCoverages,
    })),
    Effect.catchTag("FloodUnavailable", () =>
      Effect.succeed({
        observations: [],
        coverages: [
          {
            source: "flood" as const,
            polygon: extent,
            state: "unavailable" as const,
          },
        ],
      }),
    ),
  );
  return Effect.all([nowcast, flood], { concurrency: 2 }).pipe(
    Effect.map(([nowcastResult, floodResult]) => ({
      observations: [
        ...nowcastResult.observations,
        ...floodResult.observations,
      ],
      coverages: [...nowcastResult.coverages, ...floodResult.coverages],
    })),
  );
}

export class PlanRide extends Context.Service<
  PlanRide,
  {
    readonly plan: (
      request: RouteRequest,
    ) => Effect.Effect<
      DecisionOutput,
      PlaceNotFound | RouterUnavailable | InvalidDepartAt
    >;
    readonly planIntention: (
      draft: IntentionDraft,
    ) => Effect.Effect<
      DecisionOutput,
      | IntentionUnreadable
      | PlaceNotFound
      | RouterUnavailable
      | InvalidDepartAt,
      LanguageModel.LanguageModel
    >;
  }
>()("arah/PlanRide") {
  static readonly layer = Layer.effect(
    PlanRide,
    Effect.gen(function* () {
      const places = yield* Places;
      const resolver = yield* PlaceResolver;
      const state = yield* ObservationState;
      const catalog = yield* RouteCatalog;

      const executePlan = (
        request: RouteRequest,
      ): Effect.Effect<
        DecisionOutput,
        PlaceNotFound | RouterUnavailable | InvalidDepartAt
      > =>
        Effect.gen(function* () {
          const wallclockMs = yield* Clock.currentTimeMillis;
          const departMs = departureTimestamp(request.departAt, wallclockMs);
          if (Number.isNaN(departMs)) {
            return yield* new InvalidDepartAt({
              detail:
                "Scheduled departures are not supported yet. Request a departure within five minutes or use current conditions.",
            });
          }
          const nowMs = departMs;
          const homePoint: GeoPoint = {
            lat: places.home.lat,
            lon: places.home.lon,
          };

          const origin: ResolvedPlace = yield* resolver.resolve(
            request.origin,
            homePoint,
          );
          const destination: ResolvedPlace = yield* resolver.resolve(
            request.destination,
            origin.point,
          );

          const candidates = yield* goCandidates(origin, destination).pipe(
            Effect.provideService(RouteCatalog, catalog),
          );

          const decision = {
            origin,
            destination,
            intent: "go" as const,
          };

          const focus = focusPointFor(origin, destination);
          const extent = routeExtent(candidates, focus);

          const live = yield* fetchLiveWeather(nowMs, focus, extent);
          const ring = yield* resolveIsochrone(origin.point);
          const hazard = decide(
            {
              request,
              routes: candidates,
              observations: [...state.observations, ...live.observations],
              coverages: [...state.coverages, ...live.coverages],
              mapSnapshotId: places.snapshotId,
            },
            nowMs,
          );

          const rankedBase = rankGoRoutes(
            hazard.ranked,
            candidates,
            rankOptionsFrom(request.preferences, request.night),
          );
          const ranked =
            isLiveWeather() === false
              ? rankedBase
              : yield* Effect.forEach(
                  rankedBase,
                  (row) =>
                    Effect.gen(function* () {
                      const route = candidates.find(
                        (candidate) => candidate.id === row.routeId,
                      );
                      if (route === undefined) {
                        return row;
                      }
                      const samples = yield* Effect.tryPromise({
                        try: () =>
                          sampleRouteElevation(row.routeId, route.points),
                        catch: () => null,
                      }).pipe(Effect.orElseSucceed(() => []));
                      return samples.length === 0
                        ? row
                        : { ...row, elevation: [...samples] };
                    }),
                  { concurrency: 2 },
                );
          const routeSources = [
            ...new Set(candidates.map((route) => route.routeSource)),
          ];

          return {
            intent: hazard.intent,
            ranked,
            routes: [...candidates],
            observations: [...state.observations, ...live.observations],
            isochrone: [...ring],
            mapSnapshotId: hazard.mapSnapshotId,
            decidedAt: hazard.decidedAt,
            resolved: decision,
            routeSources,
          };
        }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provide(GraphHopperConfig.fromEnv),
        );

      const planIntention = (
        draft: IntentionDraft,
      ): Effect.Effect<
        DecisionOutput,
        | IntentionUnreadable
        | PlaceNotFound
        | RouterUnavailable
        | InvalidDepartAt,
        LanguageModel.LanguageModel
      > =>
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis;
          const departAt = draft.departAt ?? defaultDepartAt(nowMs);
          const request = yield* parseIntentionWithTables(draft.text, departAt);
          return yield* executePlan(request);
        });

      return PlanRide.of({
        plan: executePlan,
        planIntention,
      });
    }),
  ).pipe(
    Layer.provide(PlaceResolver.layer),
    Layer.provide(Places.layer),
    Layer.provide(ObservationState.layer),
    Layer.provide(RouteCatalog.layer),
  );
}

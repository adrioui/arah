import { Clock, Context, Effect, Layer } from "effect";
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
import { isGeoPoint } from "./domain.js";
import { decide } from "./decide.js";
import { fitTrainRanking, rankGoRoutes } from "./fit.js";
import {
  ObservationState,
  fetchFlood,
  fetchNowcast,
} from "./observations.js";
import { PlaceNotFound, PlaceResolver } from "./placeResolve.js";
import { Places } from "./places.js";
import {
  defaultDepartAt,
  IntentionDraft,
  IntentionUnreadable,
  parseIntentionWithTables,
} from "./parseIntention.js";
import { goCandidates, GraphHopperConfig, trainCandidates } from "./router.js";
import { RouteCatalog, RouterUnavailable } from "./routeCatalog.js";

function isLiveWeather(): boolean {
  return (process.env["ARAH_LIVE"] ?? "0") === "1";
}

function focusPointFor(
  request: RouteRequest,
  origin: ResolvedPlace,
  venue: ResolvedPlace | undefined,
  destination: ResolvedPlace | undefined,
): GeoPoint {
  if (request.kind === "train") {
    return venue?.point ?? origin.point;
  }
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
  const lats = points.map((point) => point.lat);
  const lons = points.map((point) => point.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
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
      coverages: [{
        source: "nowcast" as const,
        polygon: observation.polygon,
        state: "covered" as const,
      }],
    })),
    Effect.catchTag("NowcastUnavailable", () =>
      Effect.succeed({
        observations: [],
        coverages: [{
          source: "nowcast" as const,
          polygon: extent,
          state: "unavailable" as const,
        }],
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
        coverages: [{
          source: "flood" as const,
          polygon: extent,
          state: "unavailable" as const,
        }],
      }),
    ),
  );
  return Effect.all([nowcast, flood], { concurrency: 2 }).pipe(
    Effect.map(([nowcastResult, floodResult]) => ({
      observations: [...nowcastResult.observations, ...floodResult.observations],
      coverages: [...nowcastResult.coverages, ...floodResult.coverages],
    })),
  );
}

export class PlanRide extends Context.Service<
  PlanRide,
  {
    readonly plan: (
      request: RouteRequest,
    ) => Effect.Effect<DecisionOutput, PlaceNotFound | RouterUnavailable>;
    readonly planIntention: (
      draft: IntentionDraft,
    ) => Effect.Effect<
      DecisionOutput,
      IntentionUnreadable | PlaceNotFound | RouterUnavailable,
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
        PlaceNotFound | RouterUnavailable
      > =>
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis;
          const homePoint: GeoPoint = {
            lat: places.home.lat,
            lon: places.home.lon,
          };

          let origin: ResolvedPlace;
          let venue: ResolvedPlace | undefined;
          let destination: ResolvedPlace | undefined;

          if (request.kind === "train") {
            const originInput = request.origin ?? places.home.label;
            origin = isGeoPoint(originInput)
              ? {
                  label: "custom origin",
                  point: originInput,
                  source: "coords" as const,
                }
              : yield* resolver.resolve(originInput, homePoint);
            venue = yield* resolver.resolve(request.venue, origin.point);
          } else {
            origin = yield* resolver.resolve(request.origin, homePoint);
            destination = yield* resolver.resolve(
              request.destination,
              origin.point,
            );
          }

          const candidates =
            request.kind === "train"
              ? trainCandidates(venue!, places.venues, places.snapshotId)
              : yield* goCandidates(
                  origin,
                  destination!,
                ).pipe(Effect.provideService(RouteCatalog, catalog));

          const decision = (() => {
            if (request.kind === "train") {
              return {
                origin,
                venue: venue!,
                destination: undefined,
                intent: "train" as const,
              };
            }
            return {
              origin,
              venue: undefined,
              destination: destination!,
              intent: "go" as const,
            };
          })();

          const focus = focusPointFor(
            request,
            origin,
            venue,
            destination,
          );
          const extent = routeExtent(candidates, focus);

          const live = yield* fetchLiveWeather(nowMs, focus, extent);
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

          const ranked =
            request.kind === "train"
              ? fitTrainRanking(hazard.ranked, candidates, request)
              : rankGoRoutes(hazard.ranked, candidates);
          const routeSources = [
            ...new Set(candidates.map((route) => route.routeSource)),
          ];

          return {
            intent: hazard.intent,
            ranked,
            routes: [...candidates],
            observations: [...state.observations, ...live.observations],
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
        IntentionUnreadable | PlaceNotFound | RouterUnavailable,
        LanguageModel.LanguageModel
      > =>
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis;
          const departAt = draft.departAt ?? defaultDepartAt(nowMs);
          const request = yield* parseIntentionWithTables(
            draft.text,
            departAt,
          );
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
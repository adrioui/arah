import { Context, Effect, Exit, FileSystem, Layer, Schema } from "effect";
import {
  CandidateRoute,
  GeoPoint,
  ResolvedPlace,
  RouteId,
} from "./domain.js";
import { normalizePlaceQuery } from "./domain.js";

const CuratedRoute = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["loop", "point-to-point"]),
  points: Schema.Array(GeoPoint),
  distanceKm: Schema.Number,
  climbM: Schema.Number,
  laneKind: Schema.Literals(["protected", "painted", "shared", "unknown"]),
  lighting: Schema.Literals(["lit", "unlit", "unknown"]),
  mapSnapshotId: Schema.String,
  from: Schema.optional(Schema.String),
  to: Schema.optional(Schema.String),
});
type CuratedRoute = Schema.Schema.Type<typeof CuratedRoute>;

const RoutesFile = Schema.Struct({
  snapshotId: Schema.String,
  routes: Schema.Array(CuratedRoute),
});
type RoutesFile = Schema.Schema.Type<typeof RoutesFile>;

export class RouteCatalogReadError extends Schema.TaggedError<RouteCatalogReadError>()(
  "RouteCatalogReadError",
  { path: Schema.String },
) {}

export class RouteCatalogParseError extends Schema.TaggedError<RouteCatalogParseError>()(
  "RouteCatalogParseError",
  { path: Schema.String },
) {}

export class RouterUnavailable extends Schema.TaggedError<RouterUnavailable>()(
  "RouterUnavailable",
  { detail: Schema.String },
  { httpApiStatus: 422 },
) {}

const ROUTES_PATH = "data/routes.json";

function entryKey(value: string): string {
  return normalizePlaceQuery(value);
}

function toCandidateRoute(route: CuratedRoute): CandidateRoute {
  return {
    id: Schema.decodeSync(RouteId)(route.id),
    name: route.name,
    kind: route.kind,
    points: route.points,
    distanceKm: route.distanceKm,
    climbM: route.climbM,
    laneKind: route.laneKind,
    lighting: route.lighting,
    mapSnapshotId: route.mapSnapshotId,
    routeSource: "gpx",
  };
}

export class RouteCatalog extends Context.Service<
  RouteCatalog,
  {
    readonly snapshotId: string;
    readonly findPointToPoint: (
      origin: ResolvedPlace,
      destination: ResolvedPlace,
    ) => CandidateRoute | null;
  }
>()("arah/RouteCatalog") {
  static readonly layer = Layer.effect(
    RouteCatalog,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs.readFileString(ROUTES_PATH).pipe(
        Effect.catch(() =>
          Effect.fail(new RouteCatalogReadError({ path: ROUTES_PATH })),
        ),
      );
      const exit = Schema.decodeUnknownExit(Schema.fromJsonString(RoutesFile))(
        text,
      );
      if (Exit.isSuccess(exit) === false) {
        return yield* new RouteCatalogParseError({ path: ROUTES_PATH });
      }
      const data: RoutesFile = exit.value;
      const routesByPair = new Map<string, CandidateRoute>();
      for (const route of data.routes) {
        if (route.kind !== "point-to-point") {
          continue;
        }
        const from = route.from;
        const to = route.to;
        if (from === undefined || to === undefined) {
          continue;
        }
        routesByPair.set(
          `${entryKey(from)}|${entryKey(to)}`,
          toCandidateRoute(route),
        );
      }

      const findPointToPoint = (
        origin: ResolvedPlace,
        destination: ResolvedPlace,
      ): CandidateRoute | null => {
        const originKey = entryKey(origin.venueId ?? origin.label);
        const destinationKey = entryKey(destination.venueId ?? destination.label);
        return routesByPair.get(`${originKey}|${destinationKey}`) ?? null;
      };

      return RouteCatalog.of({
        snapshotId: data.snapshotId,
        findPointToPoint,
      });
    }),
  );
}
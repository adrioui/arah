import { Context, Effect, Exit, Layer, Schedule, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  CandidateRoute,
  GeoPoint,
  ResolvedPlace,
  RouteId,
} from "./domain.js";
import type { LoopTemplate, RegistryEntry } from "./places.js";
import { RouteCatalog } from "./routeCatalog.js";

const OsrmRoute = Schema.Struct({
  routes: Schema.Array(
    Schema.Struct({
      distance: Schema.Number,
      geometry: Schema.Struct({
        coordinates: Schema.Array(Schema.Array(Schema.Number)),
      }),
    }),
  ),
});

const GraphHopperRoute = Schema.Struct({
  paths: Schema.Array(
    Schema.Struct({
      distance: Schema.Number,
      time: Schema.Number,
      ascend: Schema.optional(Schema.Number),
      points: Schema.Struct({
        type: Schema.String,
        coordinates: Schema.Array(Schema.Array(Schema.Number)),
      }),
    }),
  ),
});

export interface GraphHopperOptions {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
}

export class GraphHopperConfig extends Context.Service<
  GraphHopperConfig,
  GraphHopperOptions
>()("arah/GraphHopperConfig") {
  static readonly fromEnv = Layer.succeed(GraphHopperConfig, {
    baseUrl: (process.env["GRAPHHOPPER_URL"] ?? "").trim(),
    apiKey: process.env["GRAPHHOPPER_API_KEY"],
  });
}

const DEFAULT_PACE_KMH = 18;

function osrmBaseUrl(): string {
  return process.env["ARAH_OSRM_URL"] ?? "https://router.project-osrm.org/route/v1";
}

function isOnline(): boolean {
  return (process.env["ARAH_ONLINE"] ?? "1") !== "0";
}

function decodeRouteId(raw: string): RouteId {
  return Schema.decodeSync(RouteId)(raw);
}

function lushuLoop(
  loop: LoopTemplate,
  venue: RegistryEntry,
  snapshotId: string,
): CandidateRoute {
  return {
    id: decodeRouteId(loop.id),
    name: loop.name,
    kind: "loop",
    points: loop.points,
    distanceKm: loop.distanceKm,
    climbM: loop.climbM,
    laneKind: loop.laneKind,
    lighting: loop.lighting,
    mapSnapshotId: snapshotId,
    routeSource: "lushu",
    venueId: venue.id,
  };
}

function syntheticLoop(
  center: GeoPoint,
  id: string,
  name: string,
  radiusDeg: number,
  distanceKm: number,
  snapshotId: string,
  venueId: string | undefined,
): CandidateRoute {
  const points: Array<GeoPoint> = [];
  for (let i = 0; i <= 6; i = i + 1) {
    const angle = (i / 6) * Math.PI * 2;
    points.push({
      lat: center.lat + Math.sin(angle) * radiusDeg,
      lon: center.lon + Math.cos(angle) * radiusDeg,
    });
  }
  return {
    id: decodeRouteId(id),
    name,
    kind: "loop",
    points,
    distanceKm,
    climbM: 40,
    laneKind: "unknown",
    lighting: "unknown",
    mapSnapshotId: snapshotId,
    routeSource: "synthetic",
    venueId,
  };
}

function validPoint(point: GeoPoint): boolean {
  return (
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lon) &&
    point.lat >= -90 &&
    point.lat <= 90 &&
    point.lon >= -180 &&
    point.lon <= 180
  );
}

function graphhopperPathToRoute(
  path: typeof GraphHopperRoute.Type["paths"][number],
  name: string,
  snapshotId: string,
  venueId: string | undefined,
): CandidateRoute | null {
  const points: Array<GeoPoint> = [];
  for (const pair of path.points.coordinates) {
    const lon = pair[0];
    const lat = pair[1];
    if (
      lon === undefined ||
      lat === undefined ||
      Number.isFinite(lon) === false ||
      Number.isFinite(lat) === false
    ) {
      continue;
    }
    points.push({ lat, lon });
  }
  if (
    points.length < 2 ||
    points.some((point) => validPoint(point) === false) ||
    Number.isFinite(path.distance) === false ||
    path.distance < 0 ||
    (path.ascend !== undefined &&
      (Number.isFinite(path.ascend) === false || path.ascend < 0))
  ) {
    return null;
  }
  return {
    id: decodeRouteId("go-graphhopper-primary"),
    name,
    kind: "point-to-point",
    points,
    distanceKm: path.distance / 1000,
    climbM: path.ascend ?? 0,
    laneKind: "unknown",
    lighting: "unknown",
    mapSnapshotId: snapshotId,
    routeSource: "graphhopper",
    venueId,
  };
}

function graphHopperUrl(
  config: GraphHopperOptions,
  origin: GeoPoint,
  destination: GeoPoint,
): string | null {
  if (config.baseUrl.length === 0) {
    return null;
  }
  const params = new URLSearchParams([
    ["profile", "bike"],
    ["point", `${origin.lat},${origin.lon}`],
    ["point", `${destination.lat},${destination.lon}`],
    ["points_encoded", "false"],
    ["instructions", "false"],
  ]);
  if (config.apiKey !== undefined && config.apiKey.length > 0) {
    params.set("key", config.apiKey);
  }
  return `${config.baseUrl}/route?${params.toString()}`;
}

function routeName(origin: ResolvedPlace, destination: ResolvedPlace): string {
  return `${origin.label} to ${destination.label}`;
}

function osrmToRoute(
  id: string,
  name: string,
  coordsRaw: ReadonlyArray<ReadonlyArray<number>>,
  distanceM: number,
  snapshotId: string,
  venueId: string | undefined,
): CandidateRoute | null {
  const points: Array<GeoPoint> = [];
  for (const pair of coordsRaw) {
    const lon = pair[0];
    const lat = pair[1];
    if (
      lon === undefined ||
      lat === undefined ||
      Number.isFinite(lon) === false ||
      Number.isFinite(lat) === false
    ) {
      continue;
    }
    points.push({ lat, lon });
  }
  if (
    points.length < 2 ||
    points.some((point) => validPoint(point) === false) ||
    Number.isFinite(distanceM) === false ||
    distanceM < 0
  ) {
    return null;
  }
  return {
    id: decodeRouteId(id),
    name,
    kind: "point-to-point",
    points,
    distanceKm: distanceM / 1000,
    climbM: 0,
    laneKind: "unknown",
    lighting: "unknown",
    mapSnapshotId: snapshotId,
    routeSource: "osrm",
    venueId,
  };
}

function directRoute(
  origin: GeoPoint,
  destination: GeoPoint,
  name: string,
  snapshotId: string,
): CandidateRoute {
  return {
    id: decodeRouteId("go-direct"),
    name: `${name} (direct)`,
    kind: "point-to-point",
    points: [origin, destination],
    distanceKm: haversineKm(origin, destination),
    climbM: 0,
    laneKind: "unknown",
    lighting: "unknown",
    mapSnapshotId: snapshotId,
    routeSource: "synthetic",
    venueId: undefined,
  };
}

function fetchWithRetry<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.retry(effect, {
    times: 1,
    schedule: Schedule.spaced("250 millis"),
  });
}

export function fetchGraphHopperRoute(
  origin: GeoPoint,
  destination: GeoPoint,
  id: string,
  name: string,
  snapshotId: string,
): Effect.Effect<
  CandidateRoute | null,
  never,
  HttpClient.HttpClient | GraphHopperConfig
> {
  return Effect.gen(function* () {
    if (isOnline() === false) {
      return null;
    }
    const client = yield* HttpClient.HttpClient;
    const config = yield* GraphHopperConfig;
    const url = graphHopperUrl(config, origin, destination);
    if (url === null) {
      return null;
    }
    const fetched = yield* Effect.exit(
      fetchWithRetry(
        client.get(url).pipe(
          Effect.flatMap((response) =>
            HttpClientResponse.schemaBodyJson(GraphHopperRoute)(response),
          ),
          Effect.timeout(12_000),
        ),
      ),
    );
    if (Exit.isSuccess(fetched) === false) {
      return null;
    }
    const path = fetched.value.paths[0];
    if (path === undefined) {
      return null;
    }
    return graphhopperPathToRoute(path, name, snapshotId, undefined);
  });
}

export function fetchOsrmRoute(
  origin: GeoPoint,
  destination: GeoPoint,
  id: string,
  name: string,
  snapshotId: string,
): Effect.Effect<CandidateRoute | null, never, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    if (isOnline() === false) {
      return null;
    }
    const client = yield* HttpClient.HttpClient;
    const coordPath = `${origin.lon},${origin.lat};${destination.lon},${destination.lat}`;
    const url = `${osrmBaseUrl()}/cycling/${coordPath}?overview=full&geometries=geojson`;
    const fetched = yield* Effect.exit(
      fetchWithRetry(
        client.get(url).pipe(
          Effect.flatMap((response) =>
            HttpClientResponse.schemaBodyJson(OsrmRoute)(response),
          ),
          Effect.timeout(8_000),
        ),
      ),
    );
    if (Exit.isSuccess(fetched) === false || fetched.value.routes.length === 0) {
      return null;
    }
    const route = fetched.value.routes[0];
    if (route === undefined) {
      return null;
    }
    return osrmToRoute(
      id,
      name,
      route.geometry.coordinates,
      route.distance,
      snapshotId,
      undefined,
    ) ?? null;
  });
}

export function goCandidates(
  origin: ResolvedPlace,
  destination: ResolvedPlace,
): Effect.Effect<
  ReadonlyArray<CandidateRoute>,
  never,
  RouteCatalog | HttpClient.HttpClient | GraphHopperConfig
> {
  return Effect.gen(function* () {
    const catalog = yield* RouteCatalog;
    const name = routeName(origin, destination);

    const graphhopper = yield* fetchGraphHopperRoute(
      origin.point,
      destination.point,
      "go-graphhopper-primary",
      `${name} (GraphHopper)`,
      catalog.snapshotId,
    );
    if (graphhopper !== null) {
      return [graphhopper];
    }

    const osrm = yield* fetchOsrmRoute(
      origin.point,
      destination.point,
      "go-osrm-primary",
      `${name} (OSRM)`,
      catalog.snapshotId,
    );
    if (osrm !== null) {
      return [osrm];
    }

    const curated = catalog.findPointToPoint(origin, destination);
    if (curated !== null) {
      return [curated];
    }

    return [directRoute(origin.point, destination.point, name, catalog.snapshotId)];
  });
}

function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function venueLoops(
  venue: RegistryEntry,
  snapshotId: string,
): ReadonlyArray<CandidateRoute> {
  if (venue.loops !== undefined && venue.loops.length > 0) {
    return venue.loops.map((loop) => lushuLoop(loop, venue, snapshotId));
  }
  const center = { lat: venue.lat, lon: venue.lon };
  return [
    syntheticLoop(
      center,
      `${venue.id}-short`,
      `${venue.label} short (generated)`,
      0.012,
      10,
      snapshotId,
      venue.id,
    ),
    syntheticLoop(
      center,
      `${venue.id}-long`,
      `${venue.label} long (generated)`,
      0.02,
      18,
      snapshotId,
      venue.id,
    ),
  ];
}

function findVenueById(
  venues: ReadonlyArray<RegistryEntry>,
  venueId: string,
): RegistryEntry | null {
  for (const venue of venues) {
    if (venue.id === venueId) {
      return venue;
    }
  }
  return null;
}

export function trainCandidates(
  venue: ResolvedPlace,
  venues: ReadonlyArray<RegistryEntry>,
  snapshotId: string,
): ReadonlyArray<CandidateRoute> {
  if (venue.venueId !== undefined) {
    const registryVenue = findVenueById(venues, venue.venueId);
    if (registryVenue !== null) {
      return venueLoops(registryVenue, snapshotId);
    }
  }
  return [
    syntheticLoop(
      venue.point,
      "train-generated-short",
      `${venue.label} short (generated)`,
      0.012,
      10,
      snapshotId,
      venue.venueId,
    ),
    syntheticLoop(
      venue.point,
      "train-generated-long",
      `${venue.label} long (generated)`,
      0.02,
      18,
      snapshotId,
      venue.venueId,
    ),
  ];
}

export function estimateLoopMinutes(
  distanceKm: number,
  laps: number,
  paceKmh: number = DEFAULT_PACE_KMH,
): number {
  return (distanceKm * laps * 60) / paceKmh;
}

export { DEFAULT_PACE_KMH };
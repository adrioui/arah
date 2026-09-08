import { Effect, Schema } from "effect";
import {
  CandidateRoute,
  GeoPoint,
  ResolvedPlace,
  RouteId,
} from "./domain.js";
import type { LoopTemplate, RegistryEntry } from "./places.js";
import { RouteCatalog, RouterUnavailable } from "./routeCatalog.js";

const DEFAULT_PACE_KMH = 18;

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

export function goCandidates(
  origin: ResolvedPlace,
  destination: ResolvedPlace,
): Effect.Effect<
  ReadonlyArray<CandidateRoute>,
  RouterUnavailable,
  RouteCatalog
> {
  return Effect.gen(function* () {
    const catalog = yield* RouteCatalog;
    const route = catalog.findPointToPoint(origin, destination);
    if (route === null) {
      return yield* new RouterUnavailable({
        detail: `no curated route for ${origin.label} to ${destination.label}`,
      });
    }
    return [route];
  });
}

export function estimateLoopMinutes(
  distanceKm: number,
  laps: number,
  paceKmh: number = DEFAULT_PACE_KMH,
): number {
  return (distanceKm * laps * 60) / paceKmh;
}

export { DEFAULT_PACE_KMH };
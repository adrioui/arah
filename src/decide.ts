import type {
  CandidateRoute,
  CoverageEntry,
  GeoPoint,
  Observation,
  RankedRoute,
  RouteRequest,
  Verdict,
} from "./domain.js";

/**
 * Pure route decision. No IO, no clock reads. The caller supplies now.
 * Deterministic. Same input always yields same output.
 */

const VERDICT_ORDER: Readonly<Record<Verdict, number>> = {
  block: 0,
  withhold: 1,
  warn: 2,
  allow: 3,
};

function capVerdict(found: Verdict, cap: Verdict): Verdict {
  return VERDICT_ORDER[found] <= VERDICT_ORDER[cap] ? found : cap;
}

function worstCoverage(
  first: CoverageEntry["state"],
  second: CoverageEntry["state"],
): CoverageEntry["state"] {
  const order: ReadonlyArray<CoverageEntry["state"]> = [
    "unavailable",
    "not-covered",
    "stale",
    "covered",
  ];
  return order.indexOf(first) <= order.indexOf(second) ? first : second;
}

function finitePoint(point: GeoPoint): boolean {
  return Number.isFinite(point.lat) && Number.isFinite(point.lon);
}

export function pointInPolygon(
  point: GeoPoint,
  polygon: ReadonlyArray<GeoPoint>,
): boolean {
  if (polygon.length < 3 || finitePoint(point) === false) {
    return false;
  }
  let inside = false;
  let j = polygon.length - 1;
  for (let i = 0; i < polygon.length; i = i + 1) {
    const pi = polygon[i];
    const pj = polygon[j];
    if (
      pi === undefined ||
      pj === undefined ||
      finitePoint(pi) === false ||
      finitePoint(pj) === false
    ) {
      return false;
    }
    const crosses =
      pi.lat > point.lat !== pj.lat > point.lat &&
      point.lon <
        ((pj.lon - pi.lon) * (point.lat - pi.lat)) / (pj.lat - pi.lat) + pi.lon;
    if (crosses) {
      inside = !inside;
    }
    j = i;
  }
  return inside;
}

function cross(
  a: GeoPoint,
  b: GeoPoint,
  c: GeoPoint,
): number {
  return (b.lon - a.lon) * (c.lat - a.lat) -
    (b.lat - a.lat) * (c.lon - a.lon);
}

function onSegment(
  a: GeoPoint,
  b: GeoPoint,
  point: GeoPoint,
): boolean {
  const epsilon = 1e-12;
  const collinear = Math.abs(cross(a, b, point)) <= epsilon;
  const withinLon =
    point.lon >= Math.min(a.lon, b.lon) - epsilon &&
    point.lon <= Math.max(a.lon, b.lon) + epsilon;
  const withinLat =
    point.lat >= Math.min(a.lat, b.lat) - epsilon &&
    point.lat <= Math.max(a.lat, b.lat) + epsilon;
  return collinear && withinLon && withinLat;
}

function segmentsIntersect(
  a: GeoPoint,
  b: GeoPoint,
  c: GeoPoint,
  d: GeoPoint,
): boolean {
  if (
    finitePoint(a) === false ||
    finitePoint(b) === false ||
    finitePoint(c) === false ||
    finitePoint(d) === false
  ) {
    return false;
  }
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  ) {
    return true;
  }
  if (d1 === 0 && onSegment(c, d, a)) {
    return true;
  }
  if (d2 === 0 && onSegment(c, d, b)) {
    return true;
  }
  if (d3 === 0 && onSegment(a, b, c)) {
    return true;
  }
  if (d4 === 0 && onSegment(a, b, d)) {
    return true;
  }
  return false;
}

export function routeTouches(
  route: CandidateRoute,
  polygon: ReadonlyArray<GeoPoint>,
): boolean {
  if (polygon.length < 3) {
    return false;
  }
  if (route.points.some((point) => pointInPolygon(point, polygon))) {
    return true;
  }
  for (let i = 0; i + 1 < route.points.length; i = i + 1) {
    const a = route.points[i];
    const b = route.points[i + 1];
    if (a === undefined || b === undefined) {
      continue;
    }
    for (let j = 0; j < polygon.length; j = j + 1) {
      const c = polygon[j];
      const d = polygon[(j + 1) % polygon.length];
      if (c !== undefined && d !== undefined && segmentsIntersect(a, b, c, d)) {
        return true;
      }
    }
  }
  return false;
}

export function isActive(observation: Observation, nowMs: number): boolean {
  const start = Date.parse(observation.observedAt);
  const end = Date.parse(observation.expiresAt);
  return (
    Number.isNaN(start) === false &&
    Number.isNaN(end) === false &&
    start <= nowMs &&
    nowMs <= end
  );
}

function coverageCap(state: CoverageEntry["state"]): Verdict {
  if (state === "covered") {
    return "allow";
  }
  if (state === "stale") {
    return "warn";
  }
  return "withhold";
}

export interface AssessInput {
  readonly route: CandidateRoute;
  readonly observations: ReadonlyArray<Observation>;
  readonly coverages: ReadonlyArray<CoverageEntry>;
  readonly night: boolean;
}

export function assessCandidate(
  input: AssessInput,
  nowMs: number,
): RankedRoute {
  const active = input.observations.filter((observation) =>
    isActive(observation, nowMs),
  );
  const touching = active.filter((observation) =>
    routeTouches(input.route, observation.polygon),
  );

  let verdict: Verdict = "allow";
  const reasons: Array<string> = [];
  const evidence: Array<Observation["id"]> = [];

  for (const observation of touching) {
    evidence.push(observation.id);
    if (observation.severity === "severe") {
      verdict = "block";
      reasons.push(
        `blocked by ${observation.source} ${observation.severity}: ${observation.note} [${observation.id}]`,
      );
    } else if (observation.severity === "moderate") {
      verdict = capVerdict(verdict, "warn");
      reasons.push(
        `caution for ${observation.source} ${observation.severity}: ${observation.note} [${observation.id}]`,
      );
    } else {
      reasons.push(
        `note from ${observation.source}: ${observation.note} [${observation.id}]`,
      );
    }
  }

  if (input.night && input.route.lighting === "unlit") {
    verdict = capVerdict(verdict, "warn");
    reasons.push("unlit segments at night");
  }
  if (input.night && input.route.lighting === "unknown") {
    verdict = capVerdict(verdict, "withhold");
    reasons.push("lighting unknown, cannot clear a night ride");
  }
  if (input.route.laneKind === "unknown") {
    verdict = capVerdict(verdict, "withhold");
    reasons.push("lane protection unknown, cannot claim the route is safe");
  }

  let coverage: CoverageEntry["state"] | undefined;
  for (const entry of input.coverages) {
    if (routeTouches(input.route, entry.polygon)) {
      coverage =
        coverage === undefined
          ? entry.state
          : worstCoverage(coverage, entry.state);
    }
  }
  const effectiveCoverage = coverage ?? "unavailable";
  verdict = capVerdict(verdict, coverageCap(effectiveCoverage));
  if (effectiveCoverage !== "covered") {
    reasons.push(`live coverage is ${effectiveCoverage}, worst claim withheld`);
  }
  if (reasons.length === 0) {
    reasons.push("no active hazards, facts known, coverage fresh");
  }

  return {
    routeId: input.route.id,
    routeName: input.route.name,
    verdict,
    reasons,
    evidenceIds: evidence,
    coverage: effectiveCoverage,
  };
}

export interface DecideInput {
  readonly request: RouteRequest;
  readonly routes: ReadonlyArray<CandidateRoute>;
  readonly observations: ReadonlyArray<Observation>;
  readonly coverages: ReadonlyArray<CoverageEntry>;
  readonly mapSnapshotId: string;
}

export interface DecideOutput {
  readonly intent: RouteRequest["kind"];
  readonly ranked: ReadonlyArray<RankedRoute>;
  readonly mapSnapshotId: string;
  readonly decidedAt: string;
}

export function decide(input: DecideInput, nowMs: number): DecideOutput {
  const night = input.request.night;
  const ranked = input.routes
    .map((route) =>
      assessCandidate(
        {
          route,
          observations: input.observations,
          coverages: input.coverages,
          night,
        },
        nowMs,
      ),
    )
    .sort((a, b) => {
      const byVerdict = VERDICT_ORDER[b.verdict] - VERDICT_ORDER[a.verdict];
      if (byVerdict !== 0) {
        return byVerdict;
      }
      return a.routeName < b.routeName ? -1 : 1;
    });
  return {
    intent: input.request.kind,
    ranked,
    mapSnapshotId: input.mapSnapshotId,
    decidedAt: new Date(nowMs).toISOString(),
  };
}

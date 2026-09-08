import type { CandidateRoute, RankedRoute, TrainRequest } from "./domain.js";
import { DEFAULT_PACE_KMH, estimateLoopMinutes } from "./router.js";

const VERDICT_ORDER = { block: 0, withhold: 1, warn: 2, allow: 3 };

function lapsForMinutes(distanceKm: number, targetMinutes: number): number {
  const singleLapMinutes = estimateLoopMinutes(distanceKm, 1, DEFAULT_PACE_KMH);
  if (singleLapMinutes <= 0) {
    return 1;
  }
  const raw = Math.round(targetMinutes / singleLapMinutes);
  return Math.max(1, raw);
}

function sessionTolerance(session: TrainRequest["session"]): number {
  if (session === "recovery") {
    return 0.35;
  }
  if (session === "brisk" || session === "tempo") {
    return 0.25;
  }
  return 0.2;
}

export function fitTrainRanking(
  ranked: ReadonlyArray<RankedRoute>,
  routes: ReadonlyArray<CandidateRoute>,
  request: TrainRequest,
): ReadonlyArray<RankedRoute> {
  const routeById = new Map(routes.map((route) => [route.id, route]));
  const tolerance = sessionTolerance(request.session);

  const enriched = ranked.map((row) => {
    const route = routeById.get(row.routeId);
    if (route === undefined || route.kind !== "loop") {
      return row;
    }
    const laps = lapsForMinutes(route.distanceKm, request.minutes);
    const estimated = estimateLoopMinutes(route.distanceKm, laps);
    const delta = Math.abs(estimated - request.minutes) / request.minutes;
    const fitScore = Math.max(0, 1 - delta / tolerance);
    const reasons = [...row.reasons];
    reasons.push(
      `fit: ~${estimated.toFixed(0)} min at ${laps} lap(s), target ${request.minutes} min`,
    );
    return {
      ...row,
      estimatedMinutes: estimated,
      suggestedLaps: laps,
      fitScore,
      reasons,
    };
  });

  return [...enriched].sort((a, b) => {
    const byVerdict =
      VERDICT_ORDER[b.verdict] - VERDICT_ORDER[a.verdict];
    if (byVerdict !== 0) {
      return byVerdict;
    }
    const fitA = a.fitScore ?? 0;
    const fitB = b.fitScore ?? 0;
    if (fitB !== fitA) {
      return fitB - fitA;
    }
    return a.routeName < b.routeName ? -1 : 1;
  });
}

export function rankGoRoutes(
  ranked: ReadonlyArray<RankedRoute>,
  routes: ReadonlyArray<CandidateRoute>,
): ReadonlyArray<RankedRoute> {
  const routeById = new Map(routes.map((route) => [route.id, route]));
  const enriched = ranked.map((row) => {
    const route = routeById.get(row.routeId);
    if (route === undefined) {
      return row;
    }
    const estimated = estimateLoopMinutes(route.distanceKm, 1);
    const reasons = [...row.reasons];
    reasons.push(`reach: ~${estimated.toFixed(0)} min one way at ${DEFAULT_PACE_KMH} km/h`);
    return { ...row, estimatedMinutes: estimated, reasons };
  });

  return [...enriched].sort((a, b) => {
    const byVerdict =
      VERDICT_ORDER[b.verdict] - VERDICT_ORDER[a.verdict];
    if (byVerdict !== 0) {
      return byVerdict;
    }
    const timeA = a.estimatedMinutes ?? Number.POSITIVE_INFINITY;
    const timeB = b.estimatedMinutes ?? Number.POSITIVE_INFINITY;
    return timeA - timeB;
  });
}

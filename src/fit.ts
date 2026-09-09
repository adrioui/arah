import type { CandidateRoute, RankedRoute } from "./domain.js";
import { DEFAULT_PACE_KMH, estimateLoopMinutes } from "./router.js";

const VERDICT_ORDER = { block: 0, withhold: 1, warn: 2, allow: 3 };

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
    reasons.push(
      `reach: ~${estimated.toFixed(0)} min one way at ${DEFAULT_PACE_KMH} km/h`,
    );
    return { ...row, estimatedMinutes: estimated, reasons };
  });

  return [...enriched].sort((a, b) => {
    const byVerdict = VERDICT_ORDER[b.verdict] - VERDICT_ORDER[a.verdict];
    if (byVerdict !== 0) {
      return byVerdict;
    }
    const timeA = a.estimatedMinutes ?? Number.POSITIVE_INFINITY;
    const timeB = b.estimatedMinutes ?? Number.POSITIVE_INFINITY;
    return timeA - timeB;
  });
}

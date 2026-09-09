import type {
  CandidateRoute,
  RankedRoute,
  RidePreference,
} from "./domain.js";
import { DEFAULT_PACE_KMH, estimateLoopMinutes } from "./router.js";

const VERDICT_ORDER = { block: 0, withhold: 1, warn: 2, allow: 3 };

export interface RankOptions {
  readonly hills: number;
  readonly avoidUnlit: boolean;
  readonly preferProtected: boolean;
  readonly night: boolean;
}

const DEFAULT_RANK_OPTIONS: RankOptions = {
  hills: 0.5,
  avoidUnlit: false,
  preferProtected: false,
  night: false,
};

/** Preference penalties normalized from an optional request field. */
export function rankOptionsFrom(
  preferences: RidePreference | undefined,
  night: boolean,
): RankOptions {
  return {
    hills: preferences?.hills ?? DEFAULT_RANK_OPTIONS.hills,
    avoidUnlit: preferences?.avoidUnlit ?? false,
    preferProtected: preferences?.preferProtected ?? false,
    night,
  };
}

function preferencePenalty(route: CandidateRoute, options: RankOptions): number {
  let penalty = (1 - options.hills) * (route.climbM / 500);
  if (options.avoidUnlit && options.night && route.lighting !== "lit") {
    penalty = penalty + 30;
  }
  if (options.preferProtected) {
    if (route.laneKind === "shared") {
      penalty = penalty + 10;
    } else if (route.laneKind === "painted") {
      penalty = penalty + 5;
    }
  }
  return Math.round(penalty * 10) / 10;
}

export function rankGoRoutes(
  ranked: ReadonlyArray<RankedRoute>,
  routes: ReadonlyArray<CandidateRoute>,
  options: RankOptions = DEFAULT_RANK_OPTIONS,
): ReadonlyArray<RankedRoute> {
  const routeById = new Map(routes.map((route) => [route.id, route]));
  const enriched = ranked.map((row) => {
    const route = routeById.get(row.routeId);
    if (route === undefined) {
      return row;
    }
    const estimated = estimateLoopMinutes(route.distanceKm, 1);
    const penalty = preferencePenalty(route, options);
    const reasons = [...row.reasons];
    reasons.push(
      `reach: ~${estimated.toFixed(0)} min one way at ${DEFAULT_PACE_KMH} km/h`,
    );
    if (penalty > 0) {
      reasons.push(`pref: +${penalty.toFixed(0)} min comfort penalty`);
    }
    return { ...row, estimatedMinutes: estimated + penalty, reasons };
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

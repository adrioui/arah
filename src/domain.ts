import { Exit, Schema } from "effect";

/**
 * Core domain for the arah route decider.
 *
 * Every value crossing from the outside is parsed here. Inside the
 * system these types are trusted and never re-validated.
 */

/** Branded route identifier. */
export const RouteId = Schema.String.pipe(Schema.brand("RouteId"));
export type RouteId = Schema.Schema.Type<typeof RouteId>;

/** Branded evidence identifier linking a decision to stored bytes. */
export const EvidenceId = Schema.String.pipe(Schema.brand("EvidenceId"));
export type EvidenceId = Schema.Schema.Type<typeof EvidenceId>;

/** Coverage of a live source for the requested area. */
export const CoverageState = Schema.Literals([
 "covered",
 "not-covered",
 "stale",
 "unavailable",
]);
export type CoverageState = Schema.Schema.Type<typeof CoverageState>;

/** Final recommendation per candidate. */
export const Verdict = Schema.Literals(["allow", "warn", "withhold", "block"]);
export type Verdict = Schema.Schema.Type<typeof Verdict>;

/** A geographic point. */
export const GeoPoint = Schema.Struct({
 lat: Schema.Number,
 lon: Schema.Number,
});
export type GeoPoint = Schema.Schema.Type<typeof GeoPoint>;

/** Static facts about one curated candidate route. */
export const CandidateRoute = Schema.Struct({
 id: RouteId,
 name: Schema.String,
 kind: Schema.Literals(["loop", "point-to-point"]),
 points: Schema.Array(GeoPoint),
 distanceKm: Schema.Number,
 climbM: Schema.Number,
 laneKind: Schema.Literals(["protected", "painted", "shared", "unknown"]),
 lighting: Schema.Literals(["lit", "unlit", "unknown"]),
 mapSnapshotId: Schema.String,
});
export type CandidateRoute = Schema.Schema.Type<typeof CandidateRoute>;

/** One timed hazard claim about an area. */
export const Observation = Schema.Struct({
 id: EvidenceId,
 source: Schema.Literals(["bmkg", "flood", "air", "closure", "rider"]),
 severity: Schema.Literals(["severe", "moderate", "info"]),
 polygon: Schema.Array(GeoPoint),
 observedAt: Schema.String,
 expiresAt: Schema.String,
 coverage: CoverageState,
 note: Schema.String,
});
export type Observation = Schema.Schema.Type<typeof Observation>;

/** Coverage claim for one source over an area. */
export const CoverageEntry = Schema.Struct({
 source: Schema.Literals(["bmkg", "flood", "air"]),
 polygon: Schema.Array(GeoPoint),
 state: CoverageState,
});
export type CoverageEntry = Schema.Schema.Type<typeof CoverageEntry>;

/** A training ride request. */
export const TrainRequest = Schema.Struct({
 kind: Schema.Literal("train"),
 session: Schema.Literals(["long", "tempo", "brisk", "recovery"]),
 minutes: Schema.Number,
 anchor: GeoPoint,
 departAt: Schema.String,
 night: Schema.Boolean,
});
export type TrainRequest = Schema.Schema.Type<typeof TrainRequest>;

/** A destination ride request. */
export const GoRequest = Schema.Struct({
 kind: Schema.Literal("go"),
 origin: GeoPoint,
 destinationName: Schema.String,
 destination: GeoPoint,
 departAt: Schema.String,
 night: Schema.Boolean,
});
export type GoRequest = Schema.Schema.Type<typeof GoRequest>;

/** Either accepted intent. */
export const RouteRequest = Schema.Union([TrainRequest, GoRequest]);
export type RouteRequest = Schema.Schema.Type<typeof RouteRequest>;

/** Ranked candidate with reasons. */
export const RankedRoute = Schema.Struct({
 routeId: RouteId,
 routeName: Schema.String,
 verdict: Verdict,
 reasons: Schema.Array(Schema.String),
 evidenceIds: Schema.Array(EvidenceId),
 coverage: CoverageState,
});
export type RankedRoute = Schema.Schema.Type<typeof RankedRoute>;

/** Full decision output. */
export const DecisionOutput = Schema.Struct({
 intent: Schema.Literals(["train", "go"]),
 ranked: Schema.Array(RankedRoute),
 mapSnapshotId: Schema.String,
 decidedAt: Schema.String,
});
export type DecisionOutput = Schema.Schema.Type<typeof DecisionOutput>;

/** Rider feedback input. */
export const FeedbackInput = Schema.Struct({
 routeId: RouteId,
 kind: Schema.Literals(["hazard", "closure", "praise"]),
 text: Schema.String,
 at: Schema.String,
});
export type FeedbackInput = Schema.Schema.Type<typeof FeedbackInput>;

/** Parse an inbound JSON request body. Null when malformed. */
export function parseRequestBody(body: string): RouteRequest | null {
 const exit = Schema.decodeUnknownExit(Schema.fromJsonString(RouteRequest))(
  body,
 );
 return Exit.isSuccess(exit) ? exit.value : null;
}

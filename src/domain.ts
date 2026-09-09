import { Exit, Schema } from "effect";

/**
 * Core domain for the arah route planner.
 *
 * Every value crossing from the outside is parsed here. Inside the
 * system these types are trusted and never re-validated.
 */

/** Untrusted free-text ride intention. Boundary value only. */
export const RideIntention = Schema.String.pipe(Schema.brand("RideIntention"));
export type RideIntention = Schema.Schema.Type<typeof RideIntention>;

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

/** A latitude in decimal degrees. */
export const Latitude = Schema.Number.pipe(
  Schema.check(
    Schema.isGreaterThanOrEqualTo(-90),
    Schema.isLessThanOrEqualTo(90),
  ),
);
export type Latitude = Schema.Schema.Type<typeof Latitude>;

/** A longitude in decimal degrees. */
export const Longitude = Schema.Number.pipe(
  Schema.check(
    Schema.isGreaterThanOrEqualTo(-180),
    Schema.isLessThanOrEqualTo(180),
  ),
);
export type Longitude = Schema.Schema.Type<typeof Longitude>;

/** A geographic point within valid lat/lon bounds. */
export const GeoPoint = Schema.Struct({
  lat: Latitude,
  lon: Longitude,
});
export type GeoPoint = Schema.Schema.Type<typeof GeoPoint>;

/** A finite, non-negative distance or elevation value. */
export const NonNegativeNumber = Schema.Number.pipe(
  Schema.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
);

/** A training duration in minutes. Bounded to keep routes and cost sane. */
export const PositiveMinutes = Schema.Number.pipe(
  Schema.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1440)),
);

/** An ISO date-time string that parses to a real timestamp in a sane range. */
export const DepartAt = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => {
      const timestamp = Date.parse(value);
      return (
        Number.isNaN(timestamp) === false &&
        timestamp >= 0 &&
        timestamp <= 4102444800000
      );
    }),
  ),
);
export type DepartAt = Schema.Schema.Type<typeof DepartAt>;

/**
 * JSON optional field. HttpApi encodes missing values as `null`.
 */
function jsonOptional<S extends Schema.Constraint>(schema: S) {
  return Schema.optional(Schema.NullOr(schema));
}

/** Where geocode data came from. */
export const PlaceSource = Schema.Literals([
  "registry",
  "coords",
  "nominatim",
  "photon",
]);
export type PlaceSource = Schema.Schema.Type<typeof PlaceSource>;

/** A resolved place after the geocode ladder. */
export const ResolvedPlace = Schema.Struct({
  label: Schema.String,
  point: GeoPoint,
  source: PlaceSource,
  venueId: Schema.optional(Schema.String),
});
export type ResolvedPlace = Schema.Schema.Type<typeof ResolvedPlace>;

/** Free-text name or explicit coordinates. */
export const PlaceInput = Schema.Union([GeoPoint, Schema.String]);
export type PlaceInput = Schema.Schema.Type<typeof PlaceInput>;

/** Static facts about one route candidate. */
export const CandidateRoute = Schema.Struct({
  id: RouteId,
  name: Schema.String,
  kind: Schema.Literals(["loop", "point-to-point"]),
  points: Schema.Array(GeoPoint).pipe(Schema.check(Schema.isMinLength(2))),
  distanceKm: NonNegativeNumber,
  climbM: NonNegativeNumber,
  laneKind: Schema.Literals(["protected", "painted", "shared", "unknown"]),
  lighting: Schema.Literals(["lit", "unlit", "unknown"]),
  mapSnapshotId: Schema.String,
  routeSource: Schema.Literals(["lushu", "gpx", "graphhopper", "osrm", "synthetic"]),
  venueId: jsonOptional(Schema.String),
});
export type CandidateRoute = Schema.Schema.Type<typeof CandidateRoute>;

/** One timed hazard claim about an area. */
export const Observation = Schema.Struct({
  id: EvidenceId,
  source: Schema.Literals([
    "bmkg",
    "flood",
    "air",
    "closure",
    "rider",
    "nowcast",
  ]),
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
  source: Schema.Literals(["bmkg", "flood", "air", "nowcast"]),
  polygon: Schema.Array(GeoPoint),
  state: CoverageState,
});
export type CoverageEntry = Schema.Schema.Type<typeof CoverageEntry>;

/** Training session kinds shared by requests and LLM parse output. */
export const TrainSession = Schema.Literals([
  "long",
  "tempo",
  "brisk",
  "recovery",
]);
export type TrainSession = Schema.Schema.Type<typeof TrainSession>;

/** A training ride request. Venue resolves like Go destinations. */
export const TrainRequest = Schema.Struct({
  kind: Schema.Literal("train"),
  venue: PlaceInput,
  origin: Schema.optional(PlaceInput),
  session: TrainSession,
  minutes: PositiveMinutes,
  departAt: DepartAt,
  night: Schema.Boolean,
});
export type TrainRequest = Schema.Schema.Type<typeof TrainRequest>;

/** A destination ride request. */
export const GoRequest = Schema.Struct({
  kind: Schema.Literal("go"),
  origin: PlaceInput,
  destination: PlaceInput,
  departAt: DepartAt,
  night: Schema.Boolean,
});
export type GoRequest = Schema.Schema.Type<typeof GoRequest>;

/** Either accepted intent. */
export const RouteRequest = Schema.Union([TrainRequest, GoRequest]);
export type RouteRequest = Schema.Schema.Type<typeof RouteRequest>;

/**
 * Flat object the LLM must emit. Not a union at the root because OpenAI
 * structured output rejects root `anyOf`, and RouteRequest is a union.
 */
export const LlmRideParse = Schema.Struct({
  kind: Schema.Literals(["train", "go"]),
  venue: Schema.optional(Schema.String),
  origin: Schema.optional(Schema.String),
  destination: Schema.optional(Schema.String),
  session: Schema.optional(TrainSession),
  minutes: Schema.optional(PositiveMinutes),
  night: Schema.optional(Schema.Boolean),
  departAt: jsonOptional(Schema.String),
});
export type LlmRideParse = Schema.Schema.Type<typeof LlmRideParse>;

/** Ranked candidate with reasons and optional session fit. */
export const RankedRoute = Schema.Struct({
  routeId: RouteId,
  routeName: Schema.String,
  verdict: Verdict,
  reasons: Schema.Array(Schema.String),
  evidenceIds: Schema.Array(EvidenceId),
  coverage: CoverageState,
  estimatedMinutes: Schema.optional(Schema.Number),
  suggestedLaps: Schema.optional(Schema.Number),
  fitScore: Schema.optional(Schema.Number),
});
export type RankedRoute = Schema.Schema.Type<typeof RankedRoute>;

export const ResolvedContext = Schema.Struct({
  origin: ResolvedPlace,
  venue: jsonOptional(ResolvedPlace),
  destination: jsonOptional(ResolvedPlace),
});
export type ResolvedContext = Schema.Schema.Type<typeof ResolvedContext>;

/** Full decision output. */
export const DecisionOutput = Schema.Struct({
  intent: Schema.Literals(["train", "go"]),
  ranked: Schema.Array(RankedRoute),
  routes: Schema.Array(CandidateRoute),
  observations: Schema.Array(Observation),
  mapSnapshotId: Schema.String,
  decidedAt: Schema.String,
  resolved: ResolvedContext,
  routeSources: Schema.Array(Schema.String),
});
export type DecisionOutput = Schema.Schema.Type<typeof DecisionOutput>;

/** Rider feedback input. */
export const FeedbackInput = Schema.Struct({
  routeId: RouteId,
  kind: Schema.Literals(["hazard", "closure", "praise"]),
  text: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  ),
  at: DepartAt,
});
export type FeedbackInput = Schema.Schema.Type<typeof FeedbackInput>;

/** Place search hit for autocomplete. */
export const PlaceSuggestion = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  lat: Latitude,
  lon: Longitude,
  kind: Schema.Literals(["home", "venue", "destination"]),
});
export type PlaceSuggestion = Schema.Schema.Type<typeof PlaceSuggestion>;

export const PlaceSearchResponse = Schema.Struct({
  query: Schema.String,
  suggestions: Schema.Array(PlaceSuggestion),
});
export type PlaceSearchResponse = Schema.Schema.Type<typeof PlaceSearchResponse>;

/** Parse an inbound JSON request body. Null when malformed. */
export function parseRequestBody(body: string): RouteRequest | null {
  const exit = Schema.decodeUnknownExit(Schema.fromJsonString(RouteRequest))(
    body,
  );
  return Exit.isSuccess(exit) ? exit.value : null;
}

/** Normalize a place query string for registry lookup. */
export function normalizePlaceQuery(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\b(at|in|around|near)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the input is already coordinates. */
export function isGeoPoint(input: PlaceInput): input is GeoPoint {
  return Schema.is(GeoPoint)(input);
}

/** Extract query text from a place input. */
export function placeQueryText(input: PlaceInput): string | null {
  if (isGeoPoint(input)) {
    return null;
  }
  return input;
}

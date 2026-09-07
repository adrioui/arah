import {
  Clock,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { CoverageEntry, EvidenceId, GeoPoint, Observation } from "./domain.js";

/** Fixture observation with relative validity. Materialized with a clock. */
const FixtureObservation = Schema.Struct({
  id: EvidenceId,
  source: Schema.Literals(["bmkg", "flood", "air", "closure", "rider"]),
  severity: Schema.Literals(["severe", "moderate", "info"]),
  polygon: Schema.Array(GeoPoint),
  minutesAgo: Schema.Number,
  validForMinutes: Schema.Number,
  coverage: Schema.Literals(["covered", "not-covered", "stale", "unavailable"]),
  note: Schema.String,
});
type FixtureObservation = Schema.Schema.Type<typeof FixtureObservation>;

const ObservationsFile = Schema.Struct({
  coverages: Schema.Array(CoverageEntry),
  observations: Schema.Array(FixtureObservation),
});
type ObservationsFile = Schema.Schema.Type<typeof ObservationsFile>;

const FloodPayload = Schema.Struct({
  features: Schema.Array(
    Schema.Struct({
      properties: Schema.Struct({ state: Schema.Number }),
      geometry: Schema.Struct({
        coordinates: Schema.Array(Schema.Array(Schema.Array(Schema.Number))),
      }),
    }),
  ),
});
type FloodPayload = Schema.Schema.Type<typeof FloodPayload>;

export class ObservationsReadError extends Schema.TaggedError<ObservationsReadError>()(
  "ObservationsReadError",
  { path: Schema.String },
) {}

export class ObservationsParseError extends Schema.TaggedError<ObservationsParseError>()(
  "ObservationsParseError",
  { path: Schema.String },
) {}

export type Provenance = "fixture" | "live-peta";

export interface ObservationSnapshot {
  readonly observations: ReadonlyArray<Observation>;
  readonly coverages: ReadonlyArray<CoverageEntry>;
  readonly provenance: Provenance;
}

const OBSERVATIONS_PATH = "data/observations.json";
const FLOOD_URL =
  "https://data.petabencana.id/floods?admin=ID-JK&minimum_state=1";
const MINUTE_MS = 60_000;

/** Pure materialization. Relative fixture times become absolute claims. */
export function materialize(
  fixtures: ReadonlyArray<FixtureObservation>,
  coverages: ReadonlyArray<CoverageEntry>,
  provenance: Provenance,
  nowMs: number,
): ObservationSnapshot {
  return {
    observations: fixtures.map((fixture) => ({
      id: fixture.id,
      source: fixture.source,
      severity: fixture.severity,
      polygon: fixture.polygon,
      observedAt: new Date(
        nowMs - fixture.minutesAgo * MINUTE_MS,
      ).toISOString(),
      expiresAt: new Date(
        nowMs -
          fixture.minutesAgo * MINUTE_MS +
          fixture.validForMinutes * MINUTE_MS,
      ).toISOString(),
      coverage: fixture.coverage,
      note: fixture.note,
    })),
    coverages,
    provenance,
  };
}

function floodFeatureToObservation(
  feature: FloodPayload["features"][number],
  index: number,
  nowMs: number,
): Observation | null {
  const ring = feature.geometry.coordinates[0];
  if (ring === undefined || ring.length < 3 || feature.properties.state < 1) {
    return null;
  }
  const polygon: Array<GeoPoint> = [];
  for (const pair of ring) {
    const lon = pair[0];
    const lat = pair[1];
    if (lon !== undefined && lat !== undefined) {
      polygon.push({ lat, lon });
    }
  }
  if (polygon.length < 3) {
    return null;
  }
  return {
    id: Schema.decodeSync(EvidenceId)(`peta-jakarta-${index}`),
    source: "flood",
    severity: feature.properties.state >= 3 ? "severe" : "moderate",
    polygon,
    observedAt: new Date(nowMs - 10 * MINUTE_MS).toISOString(),
    expiresAt: new Date(nowMs + 50 * MINUTE_MS).toISOString(),
    coverage: "covered",
    note: "live PetaBencana flooded area, Jakarta",
  };
}

/** Live PetaBencana fetch. Empty when the network or the payload fails. */
function fetchLiveFlood(
  nowMs: number,
): Effect.Effect<ReadonlyArray<Observation>, never, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const fetched = yield* Effect.exit(
      client.get(FLOOD_URL).pipe(
        Effect.flatMap((response) =>
          HttpClientResponse.schemaBodyJson(FloodPayload)(response),
        ),
        Effect.timeout(8000),
      ),
    );
    if (Exit.isSuccess(fetched) === false) {
      return [];
    }
    return fetched.value.features
      .map((feature, index) => floodFeatureToObservation(feature, index, nowMs))
      .filter((observation) => observation !== null);
  });
}

export class ObservationState extends Context.Service<
  ObservationState,
  ObservationSnapshot
>()("arah/ObservationState") {
  static readonly layer = Layer.effect(
    ObservationState,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs
        .readFileString(OBSERVATIONS_PATH)
        .pipe(
          Effect.catch(() =>
            Effect.fail(new ObservationsReadError({ path: OBSERVATIONS_PATH })),
          ),
        );
      const exit = Schema.decodeUnknownExit(
        Schema.fromJsonString(ObservationsFile),
      )(text);
      if (Exit.isSuccess(exit) === false) {
        return yield* new ObservationsParseError({ path: OBSERVATIONS_PATH });
      }
      const nowMs = yield* Clock.currentTimeMillis;
      const liveFlag = yield* Effect.sync(() => process.env["ARAH_LIVE"] ?? "");
      if (liveFlag !== "1") {
        return materialize(
          exit.value.observations,
          exit.value.coverages,
          "fixture",
          nowMs,
        );
      }
      const client = yield* HttpClient.HttpClient;
      const live = yield* fetchLiveFlood(nowMs).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      if (live.length === 0) {
        return materialize(
          exit.value.observations,
          exit.value.coverages,
          "fixture",
          nowMs,
        );
      }
      const base = materialize(
        exit.value.observations,
        exit.value.coverages,
        "live-peta",
        nowMs,
      );
      return { ...base, observations: [...base.observations, ...live] };
    }),
  );
}

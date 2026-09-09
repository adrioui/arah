import {
  Clock,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Schedule,
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
  minutesAgo: Schema.Number.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  validForMinutes: Schema.Number.pipe(
    Schema.check(Schema.isGreaterThan(0)),
  ),
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

const OpenMeteoPayload = Schema.Struct({
  hourly: Schema.Struct({
    time: Schema.Array(Schema.String),
    precipitation_probability: Schema.optional(Schema.Array(Schema.Number)),
    weathercode: Schema.optional(Schema.Array(Schema.Number)),
    windspeed_10m: Schema.optional(Schema.Array(Schema.Number)),
  }),
});
type OpenMeteoPayload = Schema.Schema.Type<typeof OpenMeteoPayload>;

export class ObservationsReadError extends Schema.TaggedError<ObservationsReadError>()(
  "ObservationsReadError",
  { path: Schema.String },
) {}

export class ObservationsParseError extends Schema.TaggedError<ObservationsParseError>()(
  "ObservationsParseError",
  { path: Schema.String },
) {}

export class FloodUnavailable extends Schema.TaggedError<FloodUnavailable>()(
  "FloodUnavailable",
  { detail: Schema.String },
) {}

export class NowcastUnavailable extends Schema.TaggedError<NowcastUnavailable>()(
  "NowcastUnavailable",
  { detail: Schema.String },
) {}

export type Provenance = "fixture" | "live-peta" | "live-open-meteo";

export interface ObservationSnapshot {
  readonly observations: ReadonlyArray<Observation>;
  readonly coverages: ReadonlyArray<CoverageEntry>;
  readonly provenance: Provenance;
}

const OBSERVATIONS_PATH = "data/observations.json";
const FLOOD_URL =
  "https://data.petabencana.id/floods?admin=ID-JK&minimum_state=1";
const NOWCAST_URL = "https://api.open-meteo.com/v1/forecast";
const MINUTE_MS = 60_000;

function fetchWithRetry<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.retry(effect, {
    times: 1,
    schedule: Schedule.spaced("250 millis"),
  });
}

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
    if (
      lon !== undefined &&
      lat !== undefined &&
      Number.isFinite(lon) &&
      Number.isFinite(lat)
    ) {
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

/** Live PetaBencana fetch. Fails with FloodUnavailable so callers can escape. */
export function fetchFlood(
  nowMs: number,
): Effect.Effect<
  ReadonlyArray<Observation>,
  FloodUnavailable,
  HttpClient.HttpClient
> {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const fetched = yield* fetchWithRetry(
      client.get(FLOOD_URL).pipe(
        Effect.flatMap((response) =>
          HttpClientResponse.schemaBodyJson(FloodPayload)(response),
        ),
        Effect.timeout(8_000),
      ),
    ).pipe(Effect.mapError(() => new FloodUnavailable({
      detail: "PetaBencana flood request failed",
    })));
    return fetched.features
      .map((feature, index) => floodFeatureToObservation(feature, index, nowMs))
      .filter((observation) => observation !== null);
  });
}

function weathercodeRain(code: number): boolean {
  return (
    code >= 51 && code <= 67 ||
    code >= 80 && code <= 82 ||
    code === 95 || code === 96 || code === 99
  );
}

function nowcastSeverity(
  precipitationProbability: number,
  weathercode: number,
  windSpeedKmh: number,
): Observation["severity"] {
  if (precipitationProbability >= 70 && weathercodeRain(weathercode)) {
    return "severe";
  }
  if (
    precipitationProbability >= 40 && weathercodeRain(weathercode) ||
    windSpeedKmh >= 30
  ) {
    return "moderate";
  }
  return "info";
}

function bboxAround(point: GeoPoint, radiusDeg: number): Array<GeoPoint> {
  return [
    { lat: point.lat + radiusDeg, lon: point.lon - radiusDeg },
    { lat: point.lat + radiusDeg, lon: point.lon + radiusDeg },
    { lat: point.lat - radiusDeg, lon: point.lon + radiusDeg },
    { lat: point.lat - radiusDeg, lon: point.lon - radiusDeg },
  ];
}

export function nowcastObservation(
  point: GeoPoint,
  payload: OpenMeteoPayload,
  nowMs: number,
): Observation | null {
  const hourly = payload.hourly;
  const endIndex = Math.min(hourly.time.length, 6) - 1;
  if (endIndex < 0 || hourly.time.length > 6) {
    return null;
  }
  const precipitation = hourly.precipitation_probability;
  const weathercodes = hourly.weathercode;
  const winds = hourly.windspeed_10m;
  if (
    precipitation === undefined ||
    weathercodes === undefined ||
    winds === undefined ||
    precipitation.length !== hourly.time.length ||
    weathercodes.length !== hourly.time.length ||
    winds.length !== hourly.time.length
  ) {
    return null;
  }
  const arrays = [precipitation, weathercodes, winds];
  for (const values of arrays) {
    if (values.some((value) => Number.isFinite(value) === false)) {
      return null;
    }
  }
  let worstSeverity: Observation["severity"] = "info";
  let worstNote = "next hours look rideable";
  let worstAt = hourly.time[0] ?? new Date(nowMs).toISOString();
  for (let i = 0; i <= endIndex; i = i + 1) {
    const precipitationValue = precipitation[i] ?? 0;
    const weathercode = weathercodes[i] ?? 0;
    const wind = winds[i] ?? 0;
    const severity = nowcastSeverity(precipitationValue, weathercode, wind);
    const order: ReadonlyArray<Observation["severity"]> = [
      "info",
      "moderate",
      "severe",
    ];
    if (order.indexOf(severity) > order.indexOf(worstSeverity)) {
      worstSeverity = severity;
      worstAt = hourly.time[i] ?? worstAt;
      worstNote =
        severity === "severe"
          ? `rain likely in the next hours at ${worstAt}`
          : severity === "moderate"
            ? `showery or windy in the next hours at ${worstAt}`
            : `next hours look rideable at ${worstAt}`;
    }
  }
  return {
    id: Schema.decodeSync(EvidenceId)("open-meteo-nowcast"),
    source: "nowcast",
    severity: worstSeverity,
    polygon: bboxAround(point, 0.015),
    observedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + 6 * 60 * MINUTE_MS).toISOString(),
    coverage: "covered",
    note: worstNote,
  };
}

/** Live Open-Meteo hourly forecast at one point. */
export function fetchNowcast(
  point: GeoPoint,
  nowMs: number,
): Effect.Effect<Observation, NowcastUnavailable, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const params = new URLSearchParams({
      latitude: String(point.lat),
      longitude: String(point.lon),
      hourly:
        "precipitation_probability,weathercode,windspeed_10m",
      forecast_hours: "6",
      timezone: "auto",
    });
    const fetched = yield* fetchWithRetry(
      client.get(`${NOWCAST_URL}?${params.toString()}`).pipe(
        Effect.flatMap((response) =>
          HttpClientResponse.schemaBodyJson(OpenMeteoPayload)(response),
        ),
        Effect.timeout(8_000),
      ),
    ).pipe(Effect.mapError(() => new NowcastUnavailable({
      detail: "Open-Meteo nowcast request failed",
    })));
    const observation = nowcastObservation(point, fetched, nowMs);
    if (observation === null) {
      return yield* new NowcastUnavailable({
        detail: "Open-Meteo returned no hourly frames",
      });
    }
    return observation;
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
      return materialize(
        exit.value.observations,
        exit.value.coverages,
        "fixture",
        nowMs,
      );
    }),
  );
}
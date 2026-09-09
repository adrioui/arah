import { Effect, Exit, Schema } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import type { GeoPoint } from "./domain.js";

/** Minutes of riding the ring represents. Fixed and labeled in the UI. */
export const RING_MINUTES = 30;
/** Assumed training speed for the planning ring. Fixed and labeled. */
export const RING_SPEED_KMH = 22;

const OrsIsochrone = Schema.Struct({
  features: Schema.Array(
    Schema.Struct({
      geometry: Schema.Struct({
        type: Schema.String,
        coordinates: Schema.Array(Schema.Unknown),
      }),
    }),
  ),
});

/** Flat circle polygon around a center. Pure and total. */
export function planningRing(
  center: GeoPoint,
  minutes: number = RING_MINUTES,
  speedKmh: number = RING_SPEED_KMH,
): Array<GeoPoint> {
  const radiusKm = (minutes / 60) * speedKmh;
  const radiusDeg = radiusKm / 111.32;
  const points: Array<GeoPoint> = [];
  for (let i = 0; i < 16; i = i + 1) {
    const angle = (i / 16) * Math.PI * 2;
    points.push({
      lat: center.lat + Math.sin(angle) * radiusDeg,
      lon:
        center.lon +
        (Math.cos(angle) * radiusDeg) /
          Math.max(0.2, Math.cos((center.lat * Math.PI) / 180)),
    });
  }
  return points;
}

function orsBaseUrl(): string {
  return process.env["ARAH_ORS_URL"] ?? "";
}

/** True polygon from a self-hosted ORS, null when unavailable. */
export function fetchOrsIsochrone(
  center: GeoPoint,
  minutes: number = RING_MINUTES,
): Effect.Effect<Array<GeoPoint> | null, never, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const base = orsBaseUrl();
    if (base.length === 0) {
      return null;
    }
    const client = yield* HttpClient.HttpClient;
    const httpRequest = HttpClientRequest.post(
      `${base}/v2/isochrones/cycling-regular`,
    ).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyJsonUnsafe({
        locations: [[center.lon, center.lat]],
        range: [minutes * 60],
      }),
    );
    const response = yield* client.execute(httpRequest).pipe(
      Effect.timeout(10_000),
      Effect.exit,
    );
    if (Exit.isSuccess(response) === false) {
      return null;
    }
    const payload = yield* HttpClientResponse.schemaBodyJson(OrsIsochrone)(
      response.value,
    ).pipe(Effect.exit);
    if (Exit.isSuccess(payload) === false) {
      return null;
    }
    const geometry = payload.value.features[0]?.geometry;
    if (geometry?.type !== "Polygon") {
      return null;
    }
    // SAFETY: type is checked as Polygon above, so coordinates nest lon/lat rings.
    const outer = (geometry.coordinates as Array<Array<Array<number>>>)[0];
    if (outer === undefined || outer.length < 3) {
      return null;
    }
    const points: Array<GeoPoint> = [];
    for (const pair of outer) {
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
    return points.length >= 3 ? points : null;
  });
}

/** ORS polygon first, planning ring when ORS is down or unconfigured. */
export function resolveIsochrone(
  center: GeoPoint,
): Effect.Effect<Array<GeoPoint>, never, HttpClient.HttpClient> {
  return fetchOrsIsochrone(center).pipe(
    Effect.map((polygon) => polygon ?? planningRing(center)),
  );
}

import { Context, Effect, Exit, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  GeoPoint,
  PlaceInput,
  ResolvedPlace,
  isGeoPoint,
  placeQueryText,
} from "./domain.js";
import { Places } from "./places.js";

const NominatimHit = Schema.Array(
  Schema.Struct({
    lat: Schema.String,
    lon: Schema.String,
    display_name: Schema.String,
  }),
);

const PhotonFeatureCollection = Schema.Struct({
  features: Schema.Array(
    Schema.Struct({
      properties: Schema.Struct({
        name: Schema.optional(Schema.String),
        city: Schema.optional(Schema.String),
        country: Schema.optional(Schema.String),
      }),
      geometry: Schema.Struct({
        coordinates: Schema.Array(Schema.Number),
      }),
    }),
  ),
});

export class PlaceNotFound extends Schema.TaggedError<PlaceNotFound>()(
  "PlaceNotFound",
  {
    query: Schema.String,
    tried: Schema.Array(Schema.String),
  },
  { httpApiStatus: 422 },
) {}

function fromCoords(point: GeoPoint, label: string): ResolvedPlace {
  return {
    label,
    point,
    source: "coords",
  };
}

function fromRegistry(
  label: string,
  point: GeoPoint,
  venueId: string,
): ResolvedPlace {
  return {
    label,
    point,
    source: "registry",
    venueId,
  };
}

function fetchNominatim(
  query: string,
): Effect.Effect<ResolvedPlace | null, never, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
    const fetched = yield* Effect.exit(
      client
        .get(url, {
          headers: { "User-Agent": "arah-route-planner/0.2 (local dev)" },
        })
        .pipe(
          Effect.flatMap((response) =>
            HttpClientResponse.schemaBodyJson(NominatimHit)(response),
          ),
          Effect.timeout(8000),
        ),
    );
    if (Exit.isSuccess(fetched) === false || fetched.value.length === 0) {
      return null;
    }
    const hit = fetched.value[0];
    if (hit === undefined) {
      return null;
    }
    const lat = Number(hit.lat);
    const lon = Number(hit.lon);
    if (Number.isNaN(lat) || Number.isNaN(lon)) {
      return null;
    }
    return {
      label: hit.display_name,
      point: { lat, lon },
      source: "nominatim",
    };
  });
}

function fetchPhoton(
  query: string,
  bias: GeoPoint,
): Effect.Effect<ResolvedPlace | null, never, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&lat=${bias.lat}&lon=${bias.lon}&limit=1`;
    const fetched = yield* Effect.exit(
      client
        .get(url)
        .pipe(
          Effect.flatMap((response) =>
            HttpClientResponse.schemaBodyJson(PhotonFeatureCollection)(
              response,
            ),
          ),
          Effect.timeout(8000),
        ),
    );
    if (Exit.isSuccess(fetched) === false || fetched.value.features.length === 0) {
      return null;
    }
    const feature = fetched.value.features[0];
    if (feature === undefined) {
      return null;
    }
    const coords = feature.geometry.coordinates;
    const lon = coords[0];
    const lat = coords[1];
    if (lon === undefined || lat === undefined) {
      return null;
    }
    const name = feature.properties.name ?? query;
    const city = feature.properties.city ?? "";
    const label = city.length > 0 ? `${name}, ${city}` : name;
    return {
      label,
      point: { lat, lon },
      source: "photon",
    };
  });
}

export class PlaceResolver extends Context.Service<
  PlaceResolver,
  {
    readonly resolve: (
      input: PlaceInput,
      bias: GeoPoint,
    ) => Effect.Effect<
      ResolvedPlace,
      PlaceNotFound,
      HttpClient.HttpClient
    >;
  }
>()("arah/PlaceResolver") {
  static readonly layer = Layer.effect(
    PlaceResolver,
    Effect.gen(function* () {
      const places = yield* Places;
      const resolve = (
        input: PlaceInput,
        bias: GeoPoint,
      ): Effect.Effect<
        ResolvedPlace,
        PlaceNotFound,
        HttpClient.HttpClient
      > =>
        Effect.gen(function* () {
          if (isGeoPoint(input)) {
            return fromCoords(input, `${input.lat.toFixed(4)}, ${input.lon.toFixed(4)}`);
          }

          const query = placeQueryText(input);
          if (query === null) {
            return yield* new PlaceNotFound({
              query: "invalid",
              tried: [],
            });
          }

          const tried: Array<string> = ["registry"];
          const registryHit = places.findRegistry(query);
          if (registryHit !== null) {
            return fromRegistry(
              registryHit.entry.label,
              { lat: registryHit.entry.lat, lon: registryHit.entry.lon },
              registryHit.entry.id,
            );
          }

          const onlineFlag = yield* Effect.sync(
            () => process.env["ARAH_ONLINE"] ?? "1",
          );
          if (onlineFlag === "0") {
            return yield* new PlaceNotFound({ query, tried });
          }

          tried.push("nominatim");
          const nominatim = yield* fetchNominatim(query);
          if (nominatim !== null) {
            return nominatim;
          }

          tried.push("photon");
          const photon = yield* fetchPhoton(query, bias);
          if (photon !== null) {
            return photon;
          }

          return yield* new PlaceNotFound({ query, tried });
        });

      return PlaceResolver.of({ resolve });
    }),
  ).pipe(Layer.provide(Places.layer));
}

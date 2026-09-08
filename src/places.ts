import { Context, Effect, Exit, FileSystem, Layer, Schema } from "effect";
import { GeoPoint, PlaceSuggestion, normalizePlaceQuery } from "./domain.js";

const LoopTemplate = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  points: Schema.Array(GeoPoint),
  distanceKm: Schema.Number,
  climbM: Schema.Number,
  laneKind: Schema.Literals(["protected", "painted", "shared", "unknown"]),
  lighting: Schema.Literals(["lit", "unlit", "unknown"]),
});

const RegistryEntry = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  lat: Schema.Number,
  lon: Schema.Number,
  aliases: Schema.Array(Schema.String),
  loops: Schema.optional(Schema.Array(LoopTemplate)),
});

const PlacesFile = Schema.Struct({
  snapshotId: Schema.String,
  home: RegistryEntry,
  venues: Schema.Array(RegistryEntry),
  destinations: Schema.Array(RegistryEntry),
});

export type LoopTemplate = Schema.Schema.Type<typeof LoopTemplate>;
export type RegistryEntry = Schema.Schema.Type<typeof RegistryEntry>;

export class PlacesReadError extends Schema.TaggedError<PlacesReadError>()(
  "PlacesReadError",
  { path: Schema.String },
) {}

export class PlacesParseError extends Schema.TaggedError<PlacesParseError>()(
  "PlacesParseError",
  { path: Schema.String },
) {}

const PLACES_PATH = "data/places.json";

function entryMatches(entry: RegistryEntry, normalized: string): boolean {
  if (normalizePlaceQuery(entry.label) === normalized) {
    return true;
  }
  if (normalizePlaceQuery(entry.id) === normalized) {
    return true;
  }
  for (const alias of entry.aliases) {
    const aliasNorm = normalizePlaceQuery(alias);
    if (aliasNorm === normalized || normalized.includes(aliasNorm)) {
      return true;
    }
  }
  return false;
}

export class Places extends Context.Service<
  Places,
  {
    readonly snapshotId: string;
    readonly home: RegistryEntry;
    readonly venues: ReadonlyArray<RegistryEntry>;
    readonly destinations: ReadonlyArray<RegistryEntry>;
    readonly findRegistry: (
      query: string,
    ) => { entry: RegistryEntry; kind: PlaceSuggestion["kind"] } | null;
    readonly search: (query: string) => ReadonlyArray<PlaceSuggestion>;
  }
>()("arah/Places") {
  static readonly layer = Layer.effect(
    Places,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs.readFileString(PLACES_PATH).pipe(
        Effect.catch(() =>
          Effect.fail(new PlacesReadError({ path: PLACES_PATH })),
        ),
      );
      const exit = Schema.decodeUnknownExit(Schema.fromJsonString(PlacesFile))(
        text,
      );
      if (Exit.isSuccess(exit) === false) {
        return yield* new PlacesParseError({ path: PLACES_PATH });
      }
      const data = exit.value;
      const allEntries: ReadonlyArray<{
        entry: RegistryEntry;
        kind: PlaceSuggestion["kind"];
      }> = [
        { entry: data.home, kind: "home" },
        ...data.venues.map((entry) => ({ entry, kind: "venue" as const })),
        ...data.destinations.map((entry) => ({
          entry,
          kind: "destination" as const,
        })),
      ];

      const findRegistry = (query: string) => {
        const normalized = normalizePlaceQuery(query);
        for (const row of allEntries) {
          if (entryMatches(row.entry, normalized)) {
            return row;
          }
        }
        return null;
      };

      const search = (query: string): ReadonlyArray<PlaceSuggestion> => {
        const normalized = normalizePlaceQuery(query);
        if (normalized.length === 0) {
          return [];
        }
        const hits: Array<PlaceSuggestion> = [];
        for (const row of allEntries) {
          if (entryMatches(row.entry, normalized)) {
            hits.push({
              id: row.entry.id,
              label: row.entry.label,
              lat: row.entry.lat,
              lon: row.entry.lon,
              kind: row.kind,
            });
          }
        }
        return hits;
      };

      return Places.of({
        snapshotId: data.snapshotId,
        home: data.home,
        venues: data.venues,
        destinations: data.destinations,
        findRegistry,
        search,
      });
    }),
  );
}

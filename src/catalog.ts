import { Context, Effect, Exit, FileSystem, Layer, Schema } from "effect";
import { CandidateRoute } from "./domain.js";

/** Curated routes file. Parsed at the boundary, trusted inside. */
const RoutesFile = Schema.Struct({
    snapshotId: Schema.String,
    routes: Schema.Array(CandidateRoute),
});

export class CatalogReadError extends Schema.TaggedError<CatalogReadError>()(
    "CatalogReadError",
    { path: Schema.String },
) {}

export class CatalogParseError extends Schema.TaggedError<CatalogParseError>()(
    "CatalogParseError",
    { path: Schema.String },
) {}

const ROUTES_PATH = "data/routes.json";

export class Catalog extends Context.Service<
    Catalog,
    {
        readonly snapshotId: string;
        readonly routes: ReadonlyArray<CandidateRoute>;
    }
>()("arah/Catalog") {
    static readonly layer = Layer.effect(
        Catalog,
        Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const text = yield* fs
                .readFileString(ROUTES_PATH)
                .pipe(
                    Effect.catch(() =>
                        Effect.fail(
                            new CatalogReadError({ path: ROUTES_PATH }),
                        ),
                    ),
                );
            const exit = Schema.decodeUnknownExit(
                Schema.fromJsonString(RoutesFile),
            )(text);
            if (Exit.isSuccess(exit) === false) {
                return yield* new CatalogParseError({ path: ROUTES_PATH });
            }
            return Catalog.of({
                snapshotId: exit.value.snapshotId,
                routes: exit.value.routes,
            });
        }),
    );
}

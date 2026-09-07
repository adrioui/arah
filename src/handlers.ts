import { Clock, Effect, FileSystem, Layer, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ArahApi, Health, Received, RoutesResponse } from "./api/Api.js";
import { Catalog } from "./catalog.js";
import { ObservationState } from "./observations.js";
import { decide } from "./decide.js";

const FEEDBACK_PATH = "data/feedback.jsonl";

/** Handlers without dependencies provided, so tests can supply alternatives. */
export const RidesHandlersNoDeps = HttpApiBuilder.group(
  ArahApi,
  "rides",
  Effect.fn(function*(handlers) {
    const catalog = yield* Catalog;
    const state = yield* ObservationState;
    const nowMs = yield* Clock.currentTimeMillis;

    return handlers.handleAll({
      decide: ({ payload }) =>
        Effect.succeed(
          decide(
            {
              request: payload,
              routes: catalog.routes,
              observations: state.observations,
              coverages: state.coverages,
              mapSnapshotId: catalog.snapshotId,
            },
            nowMs,
          ),
        ),
      health: () =>
        Effect.succeed<Health>({
          ok: true,
          provenance: state.provenance,
          snapshot: catalog.snapshotId,
          routes: catalog.routes.length,
        }),
      routes: () =>
        Effect.succeed<RoutesResponse>({
          snapshot: catalog.snapshotId,
          routes: [...catalog.routes],
        }),
      feedback: ({ payload }) =>
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(FEEDBACK_PATH, `${JSON.stringify(payload)}\n`, { flag: "a" }).pipe(
            Effect.orDie,
          );
          return Schema.decodeSync(Received)({ received: true });
        }),
    });
  }),
);

/** Handlers with catalog and observation layers provided, ready to serve. */
export const RidesHandlersLive = RidesHandlersNoDeps.pipe(
  Layer.provide([Catalog.layer, ObservationState.layer]),
);

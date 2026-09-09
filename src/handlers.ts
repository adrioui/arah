import { Effect, FileSystem, Layer, Schema, Semaphore } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { NodeFileSystem } from "@effect/platform-node";
import {
  ArahApi,
  FeedbackRejected,
  Health,
  Received,
} from "./api/Api.js";
import { PlaceSearchResponse } from "./domain.js";
import { ObservationState } from "./observations.js";
import { PlanRide } from "./planRide.js";
import { Places } from "./places.js";
import { RouteCatalog } from "./routeCatalog.js";

const FEEDBACK_PATH = "data/feedback.jsonl";

/** Serializes feedback reads and appends so repeated submits converge. */
const feedbackWrite = Semaphore.makeUnsafe(1);

function isOnline(): boolean {
  return (process.env["ARAH_ONLINE"] ?? "1") !== "0";
}

/** Handlers without dependencies provided, so tests can supply alternatives. */
export const RidesHandlersNoDeps = HttpApiBuilder.group(
  ArahApi,
  "rides",
  Effect.fn(function* (handlers) {
    const planner = yield* PlanRide;
    const places = yield* Places;
    const state = yield* ObservationState;
    const catalog = yield* RouteCatalog;

    return handlers.handleAll({
      decide: ({ payload }) => planner.plan(payload),
      intend: ({ payload }) => planner.planIntention(payload),
      health: () =>
        Effect.succeed<Health>({
          ok: true,
          provenance: state.provenance,
          snapshot: places.snapshotId,
          places: places.destinations.length + 1,
          online: isOnline(),
        }),
      places: ({ payload }) =>
        Effect.succeed<PlaceSearchResponse>({
          query: payload.q,
          suggestions: [...places.search(payload.q)],
        }),
      feedback: ({ payload }) =>
        Effect.gen(function* () {
          const knownRouteIds = new Set<string>(catalog.pointToPointIds);
          for (const routeId of liveGoRouteIds) {
            knownRouteIds.add(routeId);
          }
          if (knownRouteIds.has(payload.routeId) === false) {
            return yield* new FeedbackRejected({
              detail: `unknown routeId ${payload.routeId}`,
            });
          }
          const fs = yield* FileSystem.FileSystem;
          const line = `${JSON.stringify(payload)}\n`;
          yield* feedbackWrite.withPermit(
            Effect.gen(function* () {
              const exists = yield* fs.exists(FEEDBACK_PATH).pipe(Effect.orDie);
              if (exists) {
                const content = yield* fs
                  .readFileString(FEEDBACK_PATH)
                  .pipe(Effect.orDie);
                if (content.includes(line)) {
                  return;
                }
              }
              yield* fs
                .writeFileString(FEEDBACK_PATH, line, { flag: "a" })
                .pipe(Effect.orDie);
            }),
          );
          return Schema.decodeSync(Received)({ received: true });
        }),
    });
  }),
);

/** Live go route ids never stored in the catalog. */
const liveGoRouteIds: ReadonlyArray<string> = [
  "go-graphhopper-primary",
  "go-osrm-primary",
  "go-direct",
];

/** Handlers with planner and places layers provided, ready to serve. */
export const RidesHandlersLive = RidesHandlersNoDeps.pipe(
  Layer.provide([
    PlanRide.layer,
    Places.layer,
    ObservationState.layer,
    RouteCatalog.layer.pipe(Layer.provide(NodeFileSystem.layer)),
  ]),
);

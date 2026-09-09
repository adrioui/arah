import { Effect, FileSystem, Layer, Schema, Semaphore } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ArahApi, FeedbackRejected, Health, Received, RoutesResponse } from "./api/Api.js";
import { PlaceSearchResponse } from "./domain.js";
import { ObservationState } from "./observations.js";
import { PlanRide } from "./planRide.js";
import { Places } from "./places.js";
import { trainCandidates } from "./router.js";

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

    return handlers.handleAll({
      decide: ({ payload }) => planner.plan(payload),
      intend: ({ payload }) => planner.planIntention(payload),
      health: () =>
        Effect.succeed<Health>({
          ok: true,
          provenance: state.provenance,
          snapshot: places.snapshotId,
          venues: places.venues.length,
          online: isOnline(),
        }),
      places: ({ payload }) =>
        Effect.succeed<PlaceSearchResponse>({
          query: payload.q,
          suggestions: [...places.search(payload.q)],
        }),
      routes: () => {
        const allRoutes = places.venues.flatMap((venue) =>
          trainCandidates(
            {
              label: venue.label,
              point: { lat: venue.lat, lon: venue.lon },
              source: "registry",
              venueId: venue.id,
            },
            places.venues,
            places.snapshotId,
          ),
        );
        return Effect.succeed<RoutesResponse>({
          snapshot: places.snapshotId,
          routes: [...allRoutes],
        });
      },
      feedback: ({ payload }) =>
        Effect.gen(function* () {
          const knownRouteIds = new Set(
            places.venues
              .flatMap((venue) =>
                trainCandidates(
                  {
                    label: venue.label,
                    point: { lat: venue.lat, lon: venue.lon },
                    source: "registry",
                    venueId: venue.id,
                  },
                  places.venues,
                  places.snapshotId,
                ),
              )
              .map((route) => route.id),
          );
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

/** Handlers with planner and places layers provided, ready to serve. */
export const RidesHandlersLive = RidesHandlersNoDeps.pipe(
  Layer.provide([PlanRide.layer, Places.layer, ObservationState.layer]),
);

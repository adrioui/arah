import { Effect, FileSystem, Layer, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ArahApi, Health, Received, RoutesResponse } from "./api/Api.js";
import { PlaceSearchResponse } from "./domain.js";
import { ObservationState } from "./observations.js";
import { PlanRide } from "./planRide.js";
import { Places } from "./places.js";
import { trainCandidates } from "./router.js";

const FEEDBACK_PATH = "data/feedback.jsonl";

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
          const fs = yield* FileSystem.FileSystem;
          yield* fs
            .writeFileString(FEEDBACK_PATH, `${JSON.stringify(payload)}\n`, {
              flag: "a",
            })
            .pipe(Effect.orDie);
          return Schema.decodeSync(Received)({ received: true });
        }),
    });
  }),
);

/** Handlers with planner and places layers provided, ready to serve. */
export const RidesHandlersLive = RidesHandlersNoDeps.pipe(
  Layer.provide([PlanRide.layer, Places.layer, ObservationState.layer]),
);

import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/unstable/httpapi";
import {
  CandidateRoute,
  DecisionOutput,
  FeedbackInput,
  RouteRequest,
} from "../domain.js";

/** Rejected request body. The framework validates payloads first. */
export class MalformedRequest extends Schema.TaggedError<MalformedRequest>()(
  "MalformedRequest",
  { detail: Schema.String },
  { httpApiStatus: 400 },
) {}

/** Liveness plus data provenance. */
export const Health = Schema.Struct({
  ok: Schema.Boolean,
  provenance: Schema.String,
  snapshot: Schema.String,
  routes: Schema.Number,
});
export type Health = Schema.Schema.Type<typeof Health>;

/** Feedback acknowledgement. */
export const Received = Schema.Struct({
  received: Schema.Literal(true),
});
export type Received = Schema.Schema.Type<typeof Received>;

/** Curated route geometries for the map. */
export const RoutesResponse = Schema.Struct({
  snapshot: Schema.String,
  routes: Schema.Array(CandidateRoute),
});
export type RoutesResponse = Schema.Schema.Type<typeof RoutesResponse>;

export class RidesApiGroup extends HttpApiGroup.make("rides")
  .add(
    HttpApiEndpoint.post("decide", "/decide", {
      payload: RouteRequest,
      success: DecisionOutput,
    }),
  )
  .add(
    HttpApiEndpoint.get("health", "/health", {
      success: Health,
    }),
  )
  .add(
    HttpApiEndpoint.get("routes", "/routes", {
      success: RoutesResponse,
    }),
  )
  .add(
    HttpApiEndpoint.post("feedback", "/feedback", {
      payload: FeedbackInput,
      success: Received,
    }),
  )
  .prefix("/api") {}

export class ArahApi extends HttpApi.make("arah-api").add(RidesApiGroup) {}

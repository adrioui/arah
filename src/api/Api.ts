import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
} from "effect/unstable/httpapi";
import {
  DecisionOutput,
  FeedbackInput,
  PlaceSearchResponse,
  RouteRequest,
} from "../domain.js";
import {
  IntentionDraft,
  IntentionUnreadable,
} from "../parseIntention.js";
import { InvalidDepartAt } from "../planRide.js";
import { PlaceNotFound } from "../placeResolve.js";
import { RouterUnavailable } from "../routeCatalog.js";

const DecideError = Schema.Union([
  PlaceNotFound,
  RouterUnavailable,
  InvalidDepartAt,
]).annotate({
  httpApiStatus: 422,
});
export type DecideError = Schema.Schema.Type<typeof DecideError>;

const PlanError = Schema.Union([
  PlaceNotFound,
  IntentionUnreadable,
  RouterUnavailable,
  InvalidDepartAt,
]).annotate({
  httpApiStatus: 422,
});
export type PlanError = Schema.Schema.Type<typeof PlanError>;

/** Rejected request body. The framework validates payloads first. */
export class MalformedRequest extends Schema.TaggedError<MalformedRequest>()(
  "MalformedRequest",
  { detail: Schema.String },
  { httpApiStatus: 400 },
) {}

/** Feedback the server is not willing to accept. */
export class FeedbackRejected extends Schema.TaggedError<FeedbackRejected>()(
  "FeedbackRejected",
  { detail: Schema.String },
  { httpApiStatus: 422 },
) {}

/** Liveness plus data provenance. */
export const Health = Schema.Struct({
  ok: Schema.Boolean,
  provenance: Schema.String,
  snapshot: Schema.String,
  places: Schema.Number,
  online: Schema.Boolean,
});
export type Health = Schema.Schema.Type<typeof Health>;

/** Feedback acknowledgement. */
export const Received = Schema.Struct({
  received: Schema.Literal(true),
});
export type Received = Schema.Schema.Type<typeof Received>;

export class RidesApiGroup extends HttpApiGroup.make("rides")
  .add(
    HttpApiEndpoint.post("decide", "/decide", {
      payload: RouteRequest,
      success: DecisionOutput,
      error: DecideError,
    }),
  )
  .add(
    HttpApiEndpoint.post("intend", "/intend", {
      payload: IntentionDraft,
      success: DecisionOutput,
      error: PlanError,
    }),
  )
  .add(
    HttpApiEndpoint.get("health", "/health", {
      success: Health,
    }),
  )
  .add(
    HttpApiEndpoint.get("places", "/places", {
      payload: {
        q: Schema.String,
      },
      success: PlaceSearchResponse,
    }),
  )
  .add(
    HttpApiEndpoint.post("feedback", "/feedback", {
      payload: FeedbackInput,
      success: Received,
      error: FeedbackRejected,
    }),
  )
  .prefix("/api") {}

export class ArahApi extends HttpApi.make("arah-api").add(RidesApiGroup) {}

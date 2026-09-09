import { Effect, Schema } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import type { LlmRideParse, RouteRequest } from "./domain.js";
import { LlmRideParse as LlmRideParseCodec } from "./domain.js";

/** The rider typed something the parser cannot turn into a RouteRequest. */
export class IntentionUnreadable extends Schema.TaggedError<IntentionUnreadable>()(
  "IntentionUnreadable",
  { text: Schema.String },
  { httpApiStatus: 422 },
) {}

/** The model could not be reached, was not configured, or produced an unusable object. */
export class AiUnavailable extends Schema.TaggedError<AiUnavailable>()(
  "AiUnavailable",
  { reason: Schema.String },
) {}

/** The rider gave a duration that cannot become a finite positive ride length. */
export class InvalidRideDuration extends Schema.TaggedError<InvalidRideDuration>()(
  "InvalidRideDuration",
  { text: Schema.String },
  { httpApiStatus: 422 },
) {}

/** What the browser posts. departAt is optional and filled by the server clock. */
export const IntentionDraft = Schema.Struct({
  text: Schema.String.pipe(Schema.check(Schema.isMaxLength(500))),
  departAt: Schema.optional(Schema.NullOr(Schema.String)),
});
export type IntentionDraft = typeof IntentionDraft.Type;

export function defaultDepartAt(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

/**
 * Pure conversion from the flat model object to the trusted domain union.
 * Returns null when the model emitted a shape that structurally decodes but
 * cannot become a ride request.
 */
export function llmRideParseToRouteRequest(
  parsed: LlmRideParse,
  departAt: string,
): RouteRequest | null {
  const destination = parsed.destination?.trim();
  if (destination === undefined || destination.length === 0) {
    return null;
  }
  return {
    kind: "go",
    origin: parsed.origin?.trim() || "home",
    destination,
    departAt: parsed.departAt ?? departAt,
    night: parsed.night ?? false,
  };
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalize(raw: string): string {
  return clean(raw.toLowerCase().replace(/\b(night|malam)\b/g, " "));
}

function stripLeadingFillers(raw: string): string {
  return clean(
    raw.replace(/^(?:i\s+)?(?:want(?:\s+to)?|wanna|please|tolong)\s+/, ""),
  );
}

export type TableParseResult = RouteRequest | null;

/** Deterministic parser. Pure and service-free. Null means unreadable. */
export function tableParseToRouteRequest(
  rawText: string,
  departAt: string,
  nightOverride: boolean | null,
): TableParseResult {
  const text = rawText.trim();
  if (text.length === 0) {
    return null;
  }
  const night = nightOverride ?? /\b(night|malam)\b/i.test(text);
  let work = stripLeadingFillers(normalize(text));
  if (work.length === 0) {
    return null;
  }

  const goMatch = work.match(/^(?:go|bike|ride)\s+to\s+(.+)$/);
  if (goMatch !== null && goMatch[1] !== undefined) {
    const target = clean(goMatch[1]);
    if (target.length === 0) {
      return null;
    }
    const fromMatch = target.match(/^(.+?)\s+from\s+(.+)$/);
    if (
      fromMatch !== null &&
      fromMatch[1] !== undefined &&
      fromMatch[2] !== undefined
    ) {
      const destination = clean(fromMatch[1]);
      const origin = clean(fromMatch[2]);
      if (destination.length === 0 || origin.length === 0) {
        return null;
      }
      return { kind: "go", origin, destination, departAt, night };
    }
    if (/\s+from\s*$/.test(target) || /^from\s+/.test(target)) {
      return null;
    }
    return { kind: "go", origin: "home", destination: target, departAt, night };
  }
  return null;
}

/** Table-only parse. R is never. Unreadable text fails with IntentionUnreadable. */
export function parseRideIntentionTables(
  text: string,
  departAt: string,
): Effect.Effect<RouteRequest, IntentionUnreadable> {
  return Effect.suspend(
    (): Effect.Effect<RouteRequest, IntentionUnreadable> => {
      const request = tableParseToRouteRequest(text, departAt, null);
      return request === null
        ? Effect.fail(new IntentionUnreadable({ text }))
        : Effect.succeed(request);
    },
  );
}

function llmPrompt(text: string): string {
  return `Turn this rider's ride intention into a structured object.
Rules:
- The rider may add filler like "i want to" or "please". Ignore the filler and extract the ride.
- Area qualifiers like "at bintaro" belong to the place. Keep them inside destination.
- Every ride is point-to-point. Use kind "go" with origin and destination.
- Default a missing origin to "home".
- night is true only when the text asks for a night ride.
- If the text is empty or cannot become a ride, return kind "go" with destination "".
- Return only the requested object fields.

Rider text: ${text}`;
}

/**
 * Model-first parse. Failures surface as AiUnavailable so callers can escape to
 * the table parser. Empty text fails as IntentionUnreadable without calling the
 * model.
 */
export function parseIntention(
  text: string,
  departAt: string,
): Effect.Effect<
  RouteRequest,
  IntentionUnreadable | AiUnavailable,
  LanguageModel.LanguageModel
> {
  return Effect.gen(function* () {
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > 500) {
      return yield* new IntentionUnreadable({ text });
    }
    const hasApiKey = (process.env["ARAH_AI_API_KEY"] ?? "").length > 0;
    if (hasApiKey === false) {
      return yield* parseRideIntentionTables(trimmed, departAt);
    }
    const model = yield* LanguageModel.LanguageModel;
    const response = yield* model
      .generateObject({
        objectName: "ride_intention",
        schema: LlmRideParseCodec,
        prompt: llmPrompt(trimmed),
      })
      .pipe(
        Effect.timeout(8_000),
        Effect.mapError(
          () =>
            new AiUnavailable({
              reason: "language model request failed or timed out",
            }),
        ),
      );
    const request = llmRideParseToRouteRequest(response.value, departAt);
    if (request === null) {
      return yield* new AiUnavailable({
        reason: "structured decode succeeded but required fields were missing",
      });
    }
    return request;
  });
}

/** Model-first parse with the table parser as the AiUnavailable escape. */
export function parseIntentionWithTables(
  text: string,
  departAt: string,
): Effect.Effect<RouteRequest, IntentionUnreadable, LanguageModel.LanguageModel> {
  return parseIntention(text, departAt).pipe(
    Effect.catchTag("AiUnavailable", () =>
      parseRideIntentionTables(text, departAt),
    ),
  );
}

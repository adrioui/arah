import { describe, expect, it, beforeEach } from "vitest";
import { Effect, Layer, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import type { LlmRideParse } from "../src/domain.js";
import {
  llmRideParseToRouteRequest,
  parseIntention,
  parseIntentionWithTables,
  parseRideIntentionTables,
  tableParseToRouteRequest,
} from "../src/parseIntention.js";

const DEPART = "2026-09-12T05:30:00+07:00";

beforeEach(() => {
  process.env["ARAH_AI_API_KEY"] = "test-key";
});

function fakeModelLayer(model: LlmRideParse) {
  return Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () =>
        Effect.succeed([
          {
            type: "text",
            text: JSON.stringify(model),
          },
          {
            type: "finish",
            reason: "stop",
            usage: {
              inputTokens: { total: 1 },
              outputTokens: { total: 1 },
            },
          },
        ]),
      streamText: () => Stream.empty,
    }),
  );
}

function provideFakeModel(model: LlmRideParse) {
  return Effect.provide(fakeModelLayer(model));
}

describe("tableParseToRouteRequest", () => {
  it("parses the golden long ride at alsut", () => {
    const request = tableParseToRouteRequest(
      "long ride at alsut 150 min",
      DEPART,
      null,
    );
    expect(request).toEqual({
      kind: "train",
      venue: "alsut",
      minutes: 150,
      session: "long",
      departAt: DEPART,
      night: false,
    });
  });

  it("parses go to oksigasi", () => {
    expect(tableParseToRouteRequest("go to oksigasi", DEPART, null)).toEqual({
      kind: "go",
      origin: "home",
      destination: "oksigasi",
      departAt: DEPART,
      night: false,
    });
  });

  it("parses bike to oksigasi from home", () => {
    expect(
      tableParseToRouteRequest("bike to oksigasi from home", DEPART, null),
    ).toEqual({
      kind: "go",
      origin: "home",
      destination: "oksigasi",
      departAt: DEPART,
      night: false,
    });
  });

  it("parses tempo 60 min binloop night", () => {
    expect(
      tableParseToRouteRequest("tempo 60 min binloop night", DEPART, null),
    ).toEqual({
      kind: "train",
      venue: "binloop",
      minutes: 60,
      session: "tempo",
      departAt: DEPART,
      night: true,
    });
  });

  it("rejects empty and unreadable text", () => {
    expect(tableParseToRouteRequest("", DEPART, null)).toBeNull();
    expect(tableParseToRouteRequest("asdf", DEPART, null)).toBeNull();
  });
});

describe("parseRideIntentionTables", () => {
  it("fails with IntentionUnreadable for asdf", async () => {
    await expect(
      Effect.runPromise(parseRideIntentionTables("asdf", DEPART)),
    ).rejects.toMatchObject({
      _tag: "IntentionUnreadable",
      text: "asdf",
    });
  });
});

describe("llmRideParseToRouteRequest", () => {
  it("converts go output from the model shape", () => {
    const request = llmRideParseToRouteRequest(
      {
        kind: "go",
        destination: "oksigasi",
        origin: "home",
        night: false,
      },
      DEPART,
    );
    expect(request).toMatchObject({ kind: "go", destination: "oksigasi" });
  });

  it("rejects go output without destination", () => {
    expect(
      llmRideParseToRouteRequest({ kind: "go", night: false }, DEPART),
    ).toBeNull();
  });

  it("converts train output and fills departAt from the clock value", () => {
    const request = llmRideParseToRouteRequest(
      {
        kind: "train",
        venue: "alsut",
        session: "long",
        minutes: 120,
        night: false,
      },
      DEPART,
    );
    expect(request).toEqual({
      kind: "train",
      venue: "alsut",
      session: "long",
      minutes: 120,
      departAt: DEPART,
      night: false,
    });
  });
});

describe("parseIntention LLM path", () => {
  it("uses the model object and produces a RouteRequest", async () => {
    const program = parseIntention("go to oksigasi", DEPART).pipe(
      provideFakeModel({ kind: "go", destination: "oksigasi" }),
    );
    const request = await Effect.runPromise(program);
    expect(request.kind).toBe("go");
  });

  it("escapes to tables when the model output cannot become a ride", async () => {
    const program = parseIntentionWithTables(
      "long ride at alsut 150 min",
      DEPART,
    ).pipe(provideFakeModel({ kind: "go", night: false }));
    const request = await Effect.runPromise(program);
    expect(request).toEqual({
      kind: "train",
      venue: "alsut",
      minutes: 150,
      session: "long",
      departAt: DEPART,
      night: false,
    });
  });
});

describe("parseIntention failure surface", () => {
  it("surfaces AiUnavailable through the raw path and IntentionUnreadable through the escaped path", async () => {
    const unusable: LlmRideParse = { kind: "go", night: false };
    const raw = parseIntention("asdf", DEPART).pipe(
      provideFakeModel(unusable),
    );
    await expect(Effect.runPromise(raw)).rejects.toMatchObject({
      _tag: "AiUnavailable",
    });

    const escaped = parseIntentionWithTables("asdf", DEPART).pipe(
      provideFakeModel(unusable),
    );
    await expect(Effect.runPromise(escaped)).rejects.toMatchObject({
      _tag: "IntentionUnreadable",
      text: "asdf",
    });
  });
});
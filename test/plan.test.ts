import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { NodeFileSystem } from "@effect/platform-node";
import type { RouteRequest } from "../src/domain.js";
import { PlanRide } from "../src/planRide.js";

const TestLive = PlanRide.layer.pipe(Layer.provide(NodeFileSystem.layer));

const runPlan = (request: RouteRequest) =>
  Effect.gen(function* () {
    const planner = yield* PlanRide;
    return yield* planner.plan(request);
  }).pipe(Effect.provide(TestLive), Effect.provide(FetchHttpClient.layer));

describe("PlanRide", () => {
  it("plans a train ride at alsut from the registry offline", async () => {
    process.env["ARAH_ONLINE"] = "0";
    const decision = await Effect.runPromise(
      runPlan({
        kind: "train",
        venue: "alsut loop",
        session: "long",
        minutes: 150,
        departAt: new Date().toISOString(),
        night: false,
      }),
    );
    expect(decision.intent).toBe("train");
    expect(decision.resolved.venue?.label).toContain("Alsut");
    expect(decision.routes.length).toBeGreaterThan(0);
    expect(decision.ranked.length).toBeGreaterThan(0);
    expect(decision.ranked[0]?.suggestedLaps).toBeGreaterThan(0);
  });

  it("rejects a scheduled departure more than five minutes ahead", async () => {
    process.env["ARAH_ONLINE"] = "0";
    const result = await Effect.runPromise(
      runPlan({
        kind: "train",
        venue: "alsut loop",
        session: "long",
        minutes: 150,
        departAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        night: false,
      }).pipe(
        Effect.match({
          onSuccess: () => "ok" as const,
          onFailure: (error) => error,
        }),
      ),
    );
    expect(result).toMatchObject({ _tag: "InvalidDepartAt" });
  });

  it("plans a go ride between registry places offline", async () => {
    process.env["ARAH_ONLINE"] = "0";
    const decision = await Effect.runPromise(
      runPlan({
        kind: "go",
        origin: "home",
        destination: "oksigasi space",
        departAt: new Date().toISOString(),
        night: false,
      }),
    );
    expect(decision.intent).toBe("go");
    expect(decision.resolved.destination?.label).toContain("Oksigasi");
    expect(decision.routes.length).toBe(1);
    expect(decision.routes[0]?.kind).toBe("point-to-point");
  });
});

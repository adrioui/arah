import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import {
  RouteCatalog,
} from "../src/routeCatalog.js";
import { goCandidates } from "../src/router.js";

const TestLive = RouteCatalog.layer.pipe(Layer.provide(NodeFileSystem.layer));

function runCatalog() {
  return Effect.gen(function* () {
    const catalog = yield* RouteCatalog;
    return catalog.findPointToPoint(
      {
        label: "Home, Pondok Aren",
        point: { lat: -6.2842, lon: 106.7125 },
        source: "registry",
        venueId: "home",
      },
      {
        label: "Oksigasi Space",
        point: { lat: -6.2448, lon: 106.7996 },
        source: "registry",
        venueId: "oksigasi",
      },
    );
  }).pipe(Effect.provide(TestLive));
}

function runGoCandidates(destinationId: string) {
  return Effect.gen(function* () {
    const catalog = yield* RouteCatalog;
    const origin = {
      label: "Home, Pondok Aren",
      point: { lat: -6.2842, lon: 106.7125 },
      source: "registry" as const,
      venueId: "home",
    };
    const destination = {
      label: "Placeholder",
      point: { lat: -6.24, lon: 106.8 },
      source: "registry" as const,
      venueId: destinationId,
    };
    return yield* goCandidates(origin, destination).pipe(
      Effect.provideService(RouteCatalog, catalog),
    );
  }).pipe(Effect.provide(TestLive));
}

describe("RouteCatalog", () => {
  it("matches the curated home to oksigasi GPX route", async () => {
    const route = await Effect.runPromise(runCatalog());
    expect(route).not.toBeNull();
    expect(route?.routeSource).toBe("gpx");
    expect(route?.kind).toBe("point-to-point");
    expect(route?.points.length).toBeGreaterThan(1);
    expect(route?.distanceKm).toBeCloseTo(10.6, 1);
  });

  it("goCandidates returns the curated route for a known destination", async () => {
    const routes = await Effect.runPromise(runGoCandidates("oksigasi"));
    expect(routes).toHaveLength(1);
    expect(routes[0]?.routeSource).toBe("gpx");
  });

  it("goCandidates fails with RouterUnavailable for a missing destination route", async () => {
    await expect(Effect.runPromise(runGoCandidates("zzzz"))).rejects.toMatchObject(
      { _tag: "RouterUnavailable" },
    );
  });
});
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import {
  RING_MINUTES,
  RING_SPEED_KMH,
  fetchOrsIsochrone,
  planningRing,
  resolveIsochrone,
} from "../src/isochrone.js";

const CENTER = { lat: -6.2842, lon: 106.7125 };

describe("planningRing", () => {
  it("draws a 16 point circle with the expected radius", () => {
    const ring = planningRing(CENTER);
    expect(ring.length).toBe(16);
    const expectedDeg = (RING_MINUTES / 60) * RING_SPEED_KMH / 111.32;
    for (const point of ring) {
      const distance = Math.hypot(point.lat - CENTER.lat, point.lon - CENTER.lon);
      expect(Math.abs(distance - expectedDeg)).toBeLessThan(expectedDeg * 0.15);
    }
  });

  it("centers the ring on the origin", () => {
    const ring = planningRing(CENTER);
    const meanLat = ring.reduce((sum, point) => sum + point.lat, 0) / ring.length;
    const meanLon = ring.reduce((sum, point) => sum + point.lon, 0) / ring.length;
    expect(Math.abs(meanLat - CENTER.lat)).toBeLessThan(0.001);
    expect(Math.abs(meanLon - CENTER.lon)).toBeLessThan(0.001);
  });
});

describe("fetchOrsIsochrone", () => {
  it("returns null when no ORS base url is configured", async () => {
    delete process.env["ARAH_ORS_URL"];
    const polygon = await Effect.runPromise(
      fetchOrsIsochrone(CENTER).pipe(Effect.provide(FetchHttpClient.layer)),
    );
    expect(polygon).toBeNull();
  });

  it("resolveIsochrone degrades to the planning ring", async () => {
    delete process.env["ARAH_ORS_URL"];
    const polygon = await Effect.runPromise(
      resolveIsochrone(CENTER).pipe(Effect.provide(FetchHttpClient.layer)),
    );
    expect(polygon.length).toBe(16);
  });
});

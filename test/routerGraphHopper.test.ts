import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import {
  GraphHopperConfig,
  fetchGraphHopperRoute,
} from "../src/router.js";

const payload = {
  paths: [
    {
      distance: 12_345,
      time: 1_800,
      ascend: 120,
      points: {
        type: "LineString",
        coordinates: [
          [106.71, -6.28],
          [106.72, -6.29],
          [106.73, -6.3],
        ],
      },
    },
  ],
};

let server: Server;
let baseUrl: string;
let respondWithEmpty = false;

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(respondWithEmpty ? { paths: [] } : payload));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  // SAFETY: listen(0) bound a tcp port before this point, so address is AddressInfo.
  const address = server.address() as AddressInfo | null;
  if (address === null) {
    throw new Error("test server did not bind to tcp");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

function runGraphHopper() {
  return fetchGraphHopperRoute(
    { lat: -6.28, lon: 106.71 },
    { lat: -6.3, lon: 106.73 },
    "go-graphhopper-primary",
    "test (GraphHopper)",
    "snapshot-1",
  ).pipe(
    Effect.provideService(GraphHopperConfig, {
      baseUrl,
      apiKey: undefined,
    }),
    Effect.provide(FetchHttpClient.layer),
  );
}

describe("fetchGraphHopperRoute", () => {
  it("decodes the local GraphHopper response into a candidate with real points", async () => {
    const route = await Effect.runPromise(runGraphHopper());
    expect(route.routeSource).toBe("graphhopper");
    expect(route.points).toHaveLength(3);
    expect(route.distanceKm).toBe(12.345);
    expect(route.climbM).toBe(120);
  });

  it("fails with RouterUnavailable when the server returns no paths", async () => {
    respondWithEmpty = true;
    try {
      await expect(Effect.runPromise(runGraphHopper())).rejects.toMatchObject({
        _tag: "RouterUnavailable",
      });
    } finally {
      respondWithEmpty = false;
    }
  });

  it("fails with RouterUnavailable when GRAPHHOPPER_URL is not configured", async () => {
    const effect = fetchGraphHopperRoute(
      { lat: -6.28, lon: 106.71 },
      { lat: -6.3, lon: 106.73 },
      "go-graphhopper-primary",
      "test",
      "snapshot-1",
    ).pipe(
      Effect.provideService(GraphHopperConfig, {
        baseUrl: "",
        apiKey: undefined,
      }),
      Effect.provide(FetchHttpClient.layer),
    );
    await expect(Effect.runPromise(effect)).rejects.toMatchObject({
      _tag: "RouterUnavailable",
    });
  });
});
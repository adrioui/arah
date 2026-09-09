import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { FetchHttpClient } from "effect/unstable/http";
import {
  GraphHopperConfig,
  fetchGraphHopperRoute,
  fetchOsrmRoute,
  goCandidates,
} from "../src/router.js";
import { RouteCatalog } from "../src/routeCatalog.js";

const graphhopperPayload = {
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

const osrmPayload = {
  routes: [
    {
      distance: 9_876,
      geometry: {
        coordinates: [
          [106.71, -6.28],
          [106.72, -6.29],
        ],
      },
    },
  ],
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    const path = request.url ?? "";
    response.end(
      JSON.stringify(
        path.startsWith("/route") ? graphhopperPayload : osrmPayload,
      ),
    );
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

const origin = { lat: -6.28, lon: 106.71 };
const destination = { lat: -6.3, lon: 106.73 };

describe("live routing adapters", () => {
  it("decodes a GraphHopper response", async () => {
    process.env["ARAH_ONLINE"] = "1";
    const route = await Effect.runPromise(
      fetchGraphHopperRoute(
        origin,
        destination,
        "test (GraphHopper)",
        "snapshot-1",
      ).pipe(
        Effect.provideService(GraphHopperConfig, {
          baseUrl,
          apiKey: undefined,
        }),
        Effect.provide(FetchHttpClient.layer),
      ),
    );
    expect(route?.routeSource).toBe("graphhopper");
    expect(route?.points).toHaveLength(3);
    expect(route?.distanceKm).toBe(12.345);
  });

  it("decodes an OSRM response", async () => {
    process.env["ARAH_ONLINE"] = "1";
    process.env["ARAH_OSRM_URL"] = baseUrl;
    const route = await Effect.runPromise(
      fetchOsrmRoute(
        origin,
        destination,
        "go-osrm-primary",
        "test (OSRM)",
        "snapshot-1",
      ).pipe(Effect.provide(FetchHttpClient.layer)),
    );
    expect(route?.routeSource).toBe("osrm");
    expect(route?.points).toHaveLength(2);
    expect(route?.distanceKm).toBe(9.876);
  });

  it("goCandidates uses GraphHopper first", async () => {
    process.env["ARAH_ONLINE"] = "1";
    process.env["ARAH_OSRM_URL"] = baseUrl;
    const routes = await Effect.runPromise(
      goCandidates(
        {
          label: "Home",
          point: origin,
          source: "registry",
          registryId: "home",
        },
        {
          label: "Placeholder",
          point: destination,
          source: "registry",
          registryId: "unknown-destination",
        },
      ).pipe(
        Effect.provideService(GraphHopperConfig, {
          baseUrl,
          apiKey: undefined,
        }),
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(
          RouteCatalog.layer.pipe(Layer.provide(NodeFileSystem.layer)),
        ),
      ),
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]?.routeSource).toBe("graphhopper");
  });
});

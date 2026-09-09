import { createServer } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";
import { NodeHttpServer } from "@effect/platform-node";
import { ArahApi } from "./api/Api.js";
import { RidesHandlersLive } from "./handlers.js";

const ApiRoutes = HttpApiBuilder.layer(ArahApi, {
  openapiPath: "/openapi.json",
}).pipe(Layer.provide(RidesHandlersLive));

const DocsRoute = HttpApiScalar.layer(ArahApi, { path: "/docs" });

const WEB_DIST = "web/dist";
const TILES_DIR = "data/tiles";

const StaticRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    yield* router.add(
      "GET",
      "/",
      HttpServerResponse.file(path.join(WEB_DIST, "index.html"), {
        contentType: "text/html; charset=utf-8",
      }),
    );
    yield* router.add("GET", "/tiles/*", (request) =>
      Effect.gen(function* () {
        const url = new URL(request.url, "http://localhost");
        const tilePath = url.pathname.replace(/^\/tiles\//, "");
        if (
          tilePath.includes("..") ||
          tilePath.length === 0 ||
          tilePath.endsWith(".md") ||
          existsSync(path.join(TILES_DIR, tilePath)) === false
        ) {
          return HttpServerResponse.empty({ status: 404 });
        }
        return yield* HttpServerResponse.file(
          path.join(TILES_DIR, tilePath),
        );
      }),
    );
    yield* router.add("GET", "/assets/*", (request) =>
      Effect.gen(function* () {
        const url = new URL(request.url, "http://localhost");
        const assetPath = url.pathname.replace(/^\/assets\//, "");
        if (assetPath.includes("..") || assetPath.length === 0) {
          return HttpServerResponse.empty({ status: 404 });
        }
        return yield* HttpServerResponse.file(
          path.join(WEB_DIST, "assets", assetPath),
        );
      }),
    );
  }),
);

const AllRoutes = Layer.mergeAll(ApiRoutes, DocsRoute, StaticRoutes);

export const serverLayer = (port: number) =>
  HttpRouter.serve(AllRoutes).pipe(
    Layer.provide(
      NodeHttpServer.layer(createServer, { port, host: "127.0.0.1" }),
    ),
  );

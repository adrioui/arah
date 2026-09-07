import { createServer } from "node:http";
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

const StaticRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    yield* router.add(
      "GET",
      "/",
      HttpServerResponse.file("public/index.html", {
        contentType: "text/html; charset=utf-8",
      }),
    );
    yield* router.add(
      "GET",
      "/app.js",
      HttpServerResponse.file("public/app.js", {
        contentType: "text/javascript; charset=utf-8",
      }),
    );
    yield* router.add(
      "GET",
      "/styles.css",
      HttpServerResponse.file("public/styles.css", {
        contentType: "text/css; charset=utf-8",
      }),
    );
  }),
);

const AllRoutes = Layer.mergeAll(ApiRoutes, DocsRoute, StaticRoutes);

export const serverLayer = (port: number) =>
  HttpRouter.serve(AllRoutes).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { port })),
  );

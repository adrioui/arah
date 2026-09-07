import { Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { serverLayer } from "./server.js";

function resolvePort(): number {
  const raw = process.env["PORT"] ?? "8787";
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? 8787 : parsed;
}

const MainLive = serverLayer(resolvePort()).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(NodeFileSystem.layer),
);

Layer.launch(MainLive).pipe(NodeRuntime.runMain);

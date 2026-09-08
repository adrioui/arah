import { writeFileSync, unlinkSync } from "node:fs";
import { Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { AiLanguageModelLayer } from "./ai.js";
import { findAvailablePort } from "./listenPort.js";
import { serverLayer } from "./server.js";

const DEFAULT_PORT = 8790;
const DEV_PORT_FILE = ".arah-port";

function preferredPort(): number {
  const raw = process.env["PORT"];
  if (raw === undefined) {
    return DEFAULT_PORT;
  }
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? DEFAULT_PORT : parsed;
}

async function resolveListeningPort(): Promise<number> {
  try {
    unlinkSync(DEV_PORT_FILE);
  } catch {
    // no stale port file
  }
  const preferred = preferredPort();
  if (process.env["PORT"] !== undefined) {
    return preferred;
  }
  const port = await findAvailablePort(preferred);
  if (port !== preferred) {
    console.warn(
      `[arah] Port ${preferred} is busy; listening on http://0.0.0.0:${port}`,
    );
  }
  return port;
}

const port = await resolveListeningPort();
writeFileSync(DEV_PORT_FILE, String(port), "utf8");

console.log(`[arah] UI  http://127.0.0.1:${port}`);
console.log(`[arah] API http://127.0.0.1:${port}/api/health`);

const MainLive = serverLayer(port).pipe(
  Layer.provide(AiLanguageModelLayer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(NodeFileSystem.layer),
);

Layer.launch(MainLive).pipe(NodeRuntime.runMain);

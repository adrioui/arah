import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Exit, Schema } from "effect";
import { Health, Received, RoutesResponse } from "../src/api/Api.js";
import { DecisionOutput, PlaceSearchResponse } from "../src/domain.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isolatedPort = process.env["VERIFY_PORT"] ?? "8799";
const liveBase = process.env["LIVE_BASE"];
const tailnetBase = process.env["TAILNET_BASE"];

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function pass(message: string): void {
  console.log(`✓ ${message}`);
}

async function fetchResponse(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    fail(`${url} failed to connect: ${String(error)}`);
  }
}

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetchResponse(url, init);
  if (!response.ok) {
    const body = await response.text();
    fail(`${url} returned ${response.status}: ${body.slice(0, 300)}`);
  }
  return response;
}

function decodeOrFail<A, I>(
  name: string,
  schema: Schema.Codec<A, I>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters
  input: unknown,
): A {
  const exit = Schema.decodeUnknownExit(schema)(input);
  if (!Exit.isSuccess(exit)) {
    fail(`${name} failed schema decode: ${String(exit.cause)}`);
  }
  return exit.value;
}

const goldenIntents = [
  { text: "long ride at alsut 150 min", intent: "train" as const },
  { text: "go to oksigasi", intent: "go" as const },
  { text: "tempo 60 min binloop night", intent: "train" as const },
  { text: "bike to oksigasi from home", intent: "go" as const },
];

async function verifyBase(base: string, label: string): Promise<void> {
  console.log(`\n── ${label} ${base} ──`);

  const health = await fetchOk(`${base}/api/health`);
  const healthBody = decodeOrFail("GET /api/health", Health, await health.json());
  if (healthBody.ok !== true) {
    fail("/api/health body missing ok:true");
  }
  pass(`/api/health provenance=${healthBody.provenance} venues=${healthBody.venues}`);

  for (const golden of goldenIntents) {
    const response = await fetchOk(`${base}/api/intend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: golden.text }),
    });
    const body = decodeOrFail(
      `POST /api/intend ${golden.text}`,
      DecisionOutput,
      await response.json(),
    );
    if (body.intent !== golden.intent) {
      fail(`intend "${golden.text}" returned intent ${body.intent}, expected ${golden.intent}`);
    }
    if (body.ranked.length === 0 || body.routes.length === 0) {
      fail(`intend "${golden.text}" returned no routes`);
    }
    pass(
      `intend "${golden.text}" → ${body.ranked[0]?.routeName} ${body.ranked[0]?.verdict} source=${body.routes[0]?.routeSource}`,
    );
  }

  for (const unreadable of ["", "asdf"]) {
    const response = await fetchResponse(`${base}/api/intend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: unreadable }),
    });
    if (response.status !== 422 && response.status !== 400) {
      fail(`intend ${JSON.stringify(unreadable)} returned ${response.status}, expected 422`);
    }
    pass(`intend ${JSON.stringify(unreadable)} → ${response.status}`);
  }

  const missing = await fetchResponse(`${base}/api/intend`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "go to zzzz-not-a-real-place" }),
  });
  if (missing.status < 400 || missing.status >= 500) {
    fail(`unknown place returned ${missing.status}, expected 4xx`);
  }
  pass(`unknown place → ${missing.status}`);

  const malformed = await fetchResponse(`${base}/api/decide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "fly" }),
  });
  if (malformed.status < 400 || malformed.status >= 500) {
    fail(`malformed decide returned ${malformed.status}, expected 4xx`);
  }
  pass(`malformed decide → ${malformed.status}`);

  for (const query of ["alsut", "home", "oksigasi"]) {
    const places = await fetchOk(`${base}/api/places?q=${query}`);
    const body = decodeOrFail(
      `GET /api/places?q=${query}`,
      PlaceSearchResponse,
      await places.json(),
    );
    if (body.suggestions.length === 0) {
      fail(`/api/places?q=${query} returned no suggestions`);
    }
    pass(`/api/places?q=${query} → ${body.suggestions[0]?.label}`);
  }

  const routes = await fetchOk(`${base}/api/routes`);
  const routesBody = decodeOrFail("GET /api/routes", RoutesResponse, await routes.json());
  if (routesBody.routes.length === 0) {
    fail("/api/routes returned no routes");
  }
  pass(`/api/routes → ${routesBody.routes.length} geometries`);

  const feedback = await fetchOk(`${base}/api/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      routeId: "alsut-short",
      kind: "praise",
      text: "runtime-verify",
      at: "2026-09-07T14:00:00.000Z",
    }),
  });
  decodeOrFail("POST /api/feedback", Received, await feedback.json());
  pass("POST /api/feedback received");

  const index = await fetchOk(`${base}/`);
  const html = await index.text();
  if (!html.includes("arah")) {
    fail("GET / did not return Foldkit index.html");
  }
  const jsMatch = html.match(/\/assets\/[^"]+\.js/);
  const cssMatch = html.match(/\/assets\/[^"]+\.css/);
  if (jsMatch === null || cssMatch === null) {
    fail("index.html missing JS or CSS asset");
  }
  const jsPath = jsMatch[0];
  const cssPath = cssMatch[0];
  const js = await (await fetchOk(`${base}${jsPath}`)).text();
  const css = await (await fetchOk(`${base}${cssPath}`)).text();
  if (!js.includes("Ride intention") || !js.includes("arah-map")) {
    fail(`${jsPath} does not look like the arah bundle`);
  }
  if (css.length === 0) {
    fail(`${cssPath} was empty`);
  }
  pass(`SPA ${jsPath} + ${cssPath}`);

  const openapi = await fetchOk(`${base}/openapi.json`);
  const spec = await openapi.json();
  if (spec === null) {
    fail("/openapi.json was not an object");
  }
  pass("GET /openapi.json");

  const docs = await fetchOk(`${base}/docs`);
  const docsHtml = await docs.text();
  if (docsHtml.length === 0) {
    fail("GET /docs was empty");
  }
  pass("GET /docs");
}

async function waitForHealth(base: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // still starting
    }
    await sleep(200);
  }
  fail(`Server did not become healthy on ${base} within ${timeoutMs}ms`);
}

async function ensureWebDist(): Promise<void> {
  const distIndex = path.join(root, "web/dist/index.html");
  if (existsSync(distIndex)) {
    return;
  }
  console.log("Building web UI for runtime verify…");
  await new Promise<void>((resolve, reject) => {
    const build = spawn("pnpm", ["build:web"], { cwd: root, stdio: "inherit" });
    build.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error("build:web failed"));
    });
  });
}

const bases: Array<{ base: string; label: string; child?: ReturnType<typeof spawn> }> = [];

if (liveBase !== undefined && liveBase.length > 0) {
  bases.push({ base: liveBase.replace(/\/$/, ""), label: "live" });
}

if (tailnetBase !== undefined && tailnetBase.length > 0) {
  bases.push({ base: tailnetBase.replace(/\/$/, ""), label: "tailnet" });
}

if (bases.length === 0) {
  await ensureWebDist();
  const isolatedBase = `http://127.0.0.1:${isolatedPort}`;
  const server = spawn("pnpm", ["exec", "tsx", "src/main.ts"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: isolatedPort, ARAH_ONLINE: "0" },
  });
  let serverLog = "";
  server.stdout?.on("data", (chunk: Buffer) => {
    serverLog += chunk.toString();
  });
  server.stderr?.on("data", (chunk: Buffer) => {
    serverLog += chunk.toString();
  });
  try {
    await waitForHealth(isolatedBase, 15_000);
  } catch (error) {
    console.error(serverLog);
    server.kill("SIGTERM");
    throw error;
  }
  bases.push({ base: isolatedBase, label: "isolated", child: server });
}

try {
  for (const target of bases) {
    await verifyBase(target.base, target.label);
  }
  console.log("\nRuntime verify passed.");
} finally {
  for (const target of bases) {
    target.child?.kill("SIGTERM");
  }
  await sleep(300);
}

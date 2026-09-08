import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env["PORT"] ?? "8790";
const url = `http://127.0.0.1:${port}`;

function run(command, args, env = {}) {
  return spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
}

function openBrowser(target) {
  const opener = spawn("xdg-open", [target], {
    cwd: root,
    stdio: "ignore",
    detached: true,
    env: process.env,
  });
  opener.unref();
}

async function waitForHealth(base, timeoutMs = 15_000) {
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
  throw new Error(`API did not become healthy at ${base}`);
}

const stop = spawn("pnpm", ["dev:stop"], { cwd: root, stdio: "inherit" });
await new Promise((resolve) => {
  stop.on("exit", () => {
    resolve();
  });
});

const distIndex = path.join(root, "web/dist/index.html");
if (!existsSync(distIndex)) {
  console.log("[arah] Building web UI (first run)…\n");
  await new Promise((resolve, reject) => {
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

console.log(`[arah] Starting on ${url}`);

const api = run("pnpm", ["dev:api"], { PORT: port });

const shutdown = () => {
  api.kill("SIGTERM");
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

api.on("exit", (code) => {
  process.exit(code ?? 1);
});

try {
  await waitForHealth(url);
} catch (error) {
  console.error(error);
  api.kill("SIGTERM");
  process.exit(1);
}

console.log(`
┌──────────────────────────────────────────────┐
│  arah is up. Opening your browser at:        │
│  ${url}
│                                              │
│  Not 8787 (that's another app).              │
│  Not 5173 unless you ran pnpm dev:hot.       │
└──────────────────────────────────────────────┘
`);

openBrowser(url);

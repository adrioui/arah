import { spawn } from "node:child_process";
import { readFileSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const portFile = path.join(root, ".arah-port");

try {
  unlinkSync(portFile);
} catch {
  // no stale port file
}

function waitForApiPort(apiStartedAt) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const timer = setInterval(() => {
      try {
        const stat = statSync(portFile);
        if (stat.mtimeMs >= apiStartedAt - 500) {
          const port = readFileSync(portFile, "utf8").trim();
          if (port.length > 0) {
            clearInterval(timer);
            resolve(port);
            return;
          }
        }
      } catch {
        // not written yet
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for API (.arah-port)"));
      }
    }, 100);
  });
}

function run(command, args, env) {
  return spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
}

const apiStartedAt = Date.now();
const apiPort = process.env["PORT"] ?? "8790";

console.log("[arah] Stopping stale dev servers…");
await new Promise((resolve) => {
  const stop = run("pnpm", ["dev:stop"]);
  stop.on("exit", () => {
    resolve();
  });
});

const api = run("pnpm", ["dev:api"], { PORT: apiPort });
let web;

const shutdown = (signal) => {
  web?.kill(signal);
  api.kill(signal);
  process.exit(0);
};

process.on("SIGINT", () => {
  shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

api.on("exit", (code) => {
  web?.kill();
  process.exit(code ?? 1);
});

try {
  const port = await waitForApiPort(apiStartedAt);
  console.log(`\n[arah] API ready at http://127.0.0.1:${port}/api/health`);
  console.log(`
┌──────────────────────────────────────────────┐
│  OPEN http://127.0.0.1:5173 in your browser  │
│  (hot reload — keep this terminal open)      │
└──────────────────────────────────────────────┘
`);
  web = run("pnpm", ["dev:web"], { ARAH_PORT: port });
  web.on("exit", (code) => {
    api.kill();
    process.exit(code ?? 1);
  });
} catch (error) {
  console.error(error);
  api.kill();
  process.exit(1);
}

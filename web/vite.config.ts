import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(root, "..");
const devPortFile = path.join(repoRoot, ".arah-port");

function readDevApiPort(): string {
  if (process.env["ARAH_PORT"] !== undefined) {
    return process.env["ARAH_PORT"];
  }
  if (process.env["PORT"] !== undefined) {
    return process.env["PORT"];
  }
  try {
    return readFileSync(devPortFile, "utf8").trim();
  } catch {
    return "8790";
  }
}

const apiPort = readDevApiPort();
const apiTarget = `http://localhost:${apiPort}`;

export default defineConfig({
  root,
  plugins: [tailwindcss(), foldkit()],
  resolve: {
    alias: {
      "@arah/domain": path.resolve(root, "../src/domain.ts"),
    },
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": apiTarget,
      "/docs": apiTarget,
      "/openapi.json": apiTarget,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});

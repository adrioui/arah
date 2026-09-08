import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeConfig } from "vitest/config";
import { defineConfig } from "vitest/config";
import viteConfig from "./vite.config.js";

const root = path.dirname(fileURLToPath(import.meta.url));

export default mergeConfig(
  viteConfig,
  defineConfig({
    root,
    test: {
      include: ["src/**/*.test.ts"],
      environment: "happy-dom",
      setupFiles: ["./src/vitest-setup.ts"],
      server: {
        deps: {
          inline: ["foldkit", "@foldkit/ui"],
        },
      },
    },
  }),
);

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import packageJson from "./package.json" with { type: "json" };

// Vitest config — kept separate from `vite.config.ts` so the production build
// is typed purely by Vite. Component tests run in a happy-dom environment with
// the jest-dom matchers wired in via `src/test/setup.ts`.
export default defineConfig({
  plugins: [react()],
  define: {
    __RENTEMESTER_VERSION__: JSON.stringify(packageJson.version),
  },
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import packageJson from "./package.json" with { type: "json" };

// The cockpit SPA build/dev config. In dev, `/api` is proxied to
// `rentemester serve` (default port 4319) so the app and the API can be
// developed independently. The build emits to `app/dist`, which
// `rentemester serve` hosts in production.
//
// The Vitest config lives in `vitest.config.ts` so this file stays typed by
// Vite alone (a `test` key here would pull in Vitest's own nested Vite types).
export default defineConfig({
  plugins: [react()],
  define: {
    __RENTEMESTER_VERSION__: JSON.stringify(packageJson.version),
  },
  server: {
    port: 5319,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4319",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});

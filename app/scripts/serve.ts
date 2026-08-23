import cockpit from "../index.html";
import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

const preview = Bun.argv.includes("--preview");
const port = Number.parseInt(process.env.RENTEMESTER_COCKPIT_PORT ?? "5319", 10);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("RENTEMESTER_COCKPIT_PORT must be a valid TCP port");
}

if (preview) {
  const staticRoot = resolve(import.meta.dir, "../dist");
  const indexPath = resolve(staticRoot, "index.html");
  Bun.serve({
    port,
    fetch(request) {
      let requested: string | null = null;
      try {
        requested = resolve(staticRoot, `.${decodeURIComponent(new URL(request.url).pathname)}`);
      } catch {
        // Malformed paths fall through to the SPA shell.
      }
      const isInside = requested === staticRoot || requested?.startsWith(staticRoot + sep);
      const path = isInside && requested && existsSync(requested) && statSync(requested).isFile()
        ? requested
        : indexPath;
      return existsSync(path)
        ? new Response(Bun.file(path), path === indexPath ? { headers: { "cache-control": "no-cache" } } : undefined)
        : new Response("Cockpit build not found", { status: 404 });
    },
  });
} else {
  const apiBase = new URL(process.env.RENTEMESTER_API_URL ?? "http://127.0.0.1:4319");
  Bun.serve({
    port,
    development: true,
    routes: {
      "/api/*": (request) => {
        const target = new URL(request.url);
        target.protocol = apiBase.protocol;
        target.host = apiBase.host;
        return fetch(new Request(target, request));
      },
      "/*": cockpit,
    },
  });
}

// Static file serving for the cockpit SPA (#171).
//
// `rentemester serve` is primarily a JSON API (everything under `/api/*`), but
// it also hosts the built React cockpit (`app/dist`) so a single command gives
// the operator both the API and the UI. This module owns that concern alone.
//
// SPA semantics: a real file under the static root is served verbatim; any
// other path falls back to `index.html` so client-side routing (e.g.
// `/companies/acme-aps`) works on a hard refresh.

import { existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return CONTENT_TYPES[path.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Resolves a request path to a file inside `staticRoot`, guarding against
 * path-traversal: the resolved path must stay within the root. Returns null
 * when the request escapes the root or names a directory.
 */
function resolveSafe(staticRoot: string, requestPath: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(requestPath);
    } catch {
      return null;
    }
  })();
  if (decoded === null) return null;
  // normalize collapses `..` segments; the prefix check then rejects escapes.
  const rel = normalize(decoded).replace(/^[/\\]+/, "");
  const full = join(staticRoot, rel);
  if (full !== staticRoot && !full.startsWith(staticRoot + sep)) return null;
  return full;
}

/**
 * EJER-5: build info for the cockpit SPA that `rentemester serve` will serve.
 *
 * `app/dist` is gitignored and never rebuilt by `serve` itself, so the served
 * UI is whatever local build happens to exist — possibly weeks older than
 * `app/src`. The Bun build has no separate manifest, so the simplest
 * robust signal is the mtime of `index.html` (Bun rewrites it on every
 * build). `serve` reports this timestamp at startup so a stale UI is visible
 * instead of silently served; when no build exists the hint says exactly how
 * to produce one.
 */
export type StaticUiBuildInfo =
  | { present: true; staticRoot: string; builtAt: string; rebuildHint: string }
  | { present: false; staticRoot: string | null; hint: string };

const REBUILD_COMMAND = "bun run cockpit:build";

export function describeStaticUiBuild(staticRoot: string | undefined): StaticUiBuildInfo {
  const indexPath = staticRoot ? join(staticRoot, "index.html") : null;
  if (!staticRoot || !indexPath || !existsSync(indexPath)) {
    return {
      present: false,
      staticRoot: staticRoot ?? null,
      hint: `Ingen bygget cockpit-UI fundet — kun JSON-API'et serveres. Byg UI'et med: ${REBUILD_COMMAND}`,
    };
  }
  return {
    present: true,
    staticRoot,
    builtAt: statSync(indexPath).mtime.toISOString(),
    rebuildHint: `Er UI-buildet ældre end seneste frontend-ændringer (app/src), så genbyg med: ${REBUILD_COMMAND}`,
  };
}

/**
 * Serves a request from the built SPA. Returns a `Response` for a real file,
 * the SPA `index.html` fallback for unknown paths, or `null` when no static
 * root is configured / the SPA is not built (caller then 404s as a JSON API).
 */
export function serveStatic(
  staticRoot: string | undefined,
  requestPath: string,
): Response | null {
  if (!staticRoot || !existsSync(staticRoot)) return null;

  const indexPath = join(staticRoot, "index.html");
  if (!existsSync(indexPath)) return null;

  const resolved = resolveSafe(staticRoot, requestPath);
  if (resolved && existsSync(resolved) && statSync(resolved).isFile()) {
    return new Response(Bun.file(resolved), {
      headers: { "content-type": contentTypeFor(resolved) },
    });
  }

  // SPA fallback — any non-file path renders the app shell so the client
  // router can take over. Never cached so a redeploy is picked up.
  return new Response(Bun.file(indexPath), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}

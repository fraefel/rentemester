// Narrow, secret-free request-completion observability at the Bun.serve edge.

import type { DeploymentProfile, ServerConfig } from "./config";
import { matchCatalogRoute } from "./router";

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOGGABLE_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export type RequestLogEvent = {
  timestamp: string;
  level: "info" | "warn" | "error";
  event: "http_request_complete";
  requestId: string;
  method: string;
  /** A fixed catalog template or fixed anonymous bucket, never raw URL/path. */
  pathTemplate: string;
  status: number;
  durationMs: number;
  deploymentProfile: DeploymentProfile;
};

export type RequestLogSink = {
  emit(event: RequestLogEvent): void;
};

function defaultRequestLogSink(): RequestLogSink {
  return {
    emit(event) {
      // JSON serialization is only over this allowlisted event shape.
      process.stdout.write(`${JSON.stringify(event)}\n`);
    },
  };
}

function requestId(request: Request, factory: (() => string) | undefined): string {
  const supplied = request.headers.get("x-request-id");
  if (supplied && REQUEST_ID.test(supplied)) return supplied;
  const generated = factory?.() ?? crypto.randomUUID();
  return REQUEST_ID.test(generated) ? generated : crypto.randomUUID();
}

function pathTemplate(method: string, request: Request): string {
  let path: string;
  try {
    path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return "/invalid-request";
  }
  if (path === "/api/auth" || path.startsWith("/api/auth/")) return "/api/auth/*";
  const catalogued = matchCatalogRoute(method, path);
  if (catalogued) return catalogued.entry.pattern;
  if (path === "/api" || path.startsWith("/api/")) return "/api/*";
  return "/ui/*";
}

function levelForStatus(status: number): RequestLogEvent["level"] {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
}

function safeMethod(value: string): string {
  const normalized = value.toUpperCase();
  return LOGGABLE_METHODS.has(normalized) ? normalized : "OTHER";
}

function addRequestId(response: Response, id: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", id);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Wraps a pure request handler without ever serialising its request/error. */
export async function observeRequest(
  request: Request,
  config: ServerConfig,
  next: (request: Request, config: ServerConfig) => Promise<Response>,
): Promise<Response> {
  const now = config.requestLogClock ?? Date.now;
  const startedAt = now();
  const method = safeMethod(request.method);
  const id = requestId(request, config.requestIdFactory);
  const template = pathTemplate(method, request);
  let status = 500;
  try {
    const response = await next(request, { ...config, requestId: id });
    status = response.status;
    return addRequestId(response, id);
  } finally {
    const event: RequestLogEvent = {
      timestamp: new Date(startedAt).toISOString(),
      level: levelForStatus(status),
      event: "http_request_complete",
      requestId: id,
      method,
      pathTemplate: template,
      status,
      durationMs: Math.max(0, Math.round(now() - startedAt)),
      deploymentProfile: config.deploymentProfile ?? "local",
    };
    try {
      (config.requestLogSink ?? defaultRequestLogSink()).emit(event);
    } catch {
      // Logging never changes an HTTP response and has no raw fallback.
    }
  }
}

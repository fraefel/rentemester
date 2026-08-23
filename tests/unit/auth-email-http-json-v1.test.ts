import { describe, expect, test } from "bun:test";
import {
  AuthEmailDeliveryError,
  createHttpJsonV1AuthEmailSender,
} from "../../src/server/auth-email";

const gatewayConfig = {
  url: "https://gateway.example.test/v1/send",
  bearerToken: "gateway-test-token",
  from: "auth@rentemester.example.test",
  idempotencySecret: "Wc2!rM7#fQ9$zL4@pT8%vN3^xH6&kD1Aa",
};
const message = {
  kind: "verification" as const,
  recipient: "user@example.test",
  url: "https://cockpit.example.test/api/auth/verify-email?token=private-token",
  token: "private-token",
};

describe("auth email HTTP JSON v1 gateway", () => {
  test("sends the exact versioned contract with an opaque deterministic idempotency key", async () => {
    const sent: Request[] = [];
    const sender = createHttpJsonV1AuthEmailSender(gatewayConfig, {
      async fetch(request) { sent.push(request); return new Response(null, { status: 202 }); },
    });
    await sender.send(message);
    expect(sent).toHaveLength(1);
    const request = sent[0]!;
    expect(request.url).toBe(gatewayConfig.url);
    expect(request.method).toBe("POST");
    expect([...request.headers.keys()].sort()).toEqual([
      "authorization", "content-type", "idempotency-key", "x-rentemester-auth-event",
    ]);
    expect(request.headers.get("authorization")).toBe("Bearer gateway-test-token");
    expect(request.headers.get("x-rentemester-auth-event")).toBe("verification");
    const key = request.headers.get("idempotency-key")!;
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain(message.token);
    expect(await request.json()).toEqual({
      version: "rentemester-auth-email-v1",
      kind: "verification",
      to: "user@example.test",
      from: "auth@rentemester.example.test",
      subject: "Bekræft din e-mailadresse i Rentemester",
      text: "Bekræft din e-mailadresse ved at åbne linket.",
      actionUrl: message.url,
    });
  });

  test("delivers invitation links as the same bounded provider contract", async () => {
    const sent: Request[] = [];
    const sender = createHttpJsonV1AuthEmailSender(gatewayConfig, {
      async fetch(request) { sent.push(request); return new Response(null, { status: 202 }); },
    });
    await sender.send({
      kind: "workspace-invitation",
      recipient: "invitee@example.test",
      url: "https://cockpit.example.test/invite#token=opaque-fragment-token",
      token: "opaque-fragment-token",
    });
    const request = sent[0]!;
    expect(request.headers.get("x-rentemester-auth-event")).toBe("workspace-invitation");
    expect(await request.json()).toMatchObject({
      kind: "workspace-invitation",
      subject: "Du er inviteret til Rentemester",
      actionUrl: "https://cockpit.example.test/invite#token=opaque-fragment-token",
    });
  });

  test("retries network/5xx/429 using the same idempotency key but never retries a 4xx", async () => {
    const keys: string[] = [];
    let calls = 0;
    const sender = createHttpJsonV1AuthEmailSender(gatewayConfig, {
      async fetch(request) {
        keys.push(request.headers.get("idempotency-key")!);
        calls += 1;
        if (calls === 1) throw new TypeError("network unavailable");
        return new Response(null, { status: calls === 2 ? 503 : 202 });
      },
      async sleep() {},
    });
    await sender.send(message);
    expect(keys).toEqual([keys[0], keys[0], keys[0]]);

    let throttledCalls = 0;
    const throttled = createHttpJsonV1AuthEmailSender(gatewayConfig, {
      async fetch() { throttledCalls += 1; return new Response(null, { status: throttledCalls === 1 ? 429 : 202 }); },
      async sleep() {},
    });
    await throttled.send(message);
    expect(throttledCalls).toBe(2);

    let rejectedCalls = 0;
    const rejected = createHttpJsonV1AuthEmailSender(gatewayConfig, {
      async fetch() { rejectedCalls += 1; return new Response("private provider detail", { status: 400 }); },
    });
    await expect(rejected.send(message)).rejects.toEqual(new AuthEmailDeliveryError());
    expect(rejectedCalls).toBe(1);
  });

  test("enforces its deadline with injected timing and exposes only a sanitized error", async () => {
    const sender = createHttpJsonV1AuthEmailSender(gatewayConfig, {
      async fetch() { return await new Promise<Response>(() => {}); },
      async sleep() {},
      clock: () => 0,
    });
    await expect(sender.send(message)).rejects.toEqual(new AuthEmailDeliveryError());
  });
});

import { expect, test } from "bun:test";
import { mockFetch } from "./_shared";

test("mockFetch rejects unmatched requests instead of returning a catchable API response", async () => {
  mockFetch({ "GET /api/expected": { value: true } });
  await expect(fetch("/api/unexpected")).rejects.toThrow(
    "Unexpected fetch request: GET /api/unexpected",
  );
});

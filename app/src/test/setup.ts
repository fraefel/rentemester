// Vitest global setup — adds jest-dom matchers and resets DOM/mocks between
// tests so each spec runs against a clean slate.
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

let consoleProblems: string[] = [];

beforeEach(() => {
  consoleProblems = [];
  vi.spyOn(console, "warn").mockImplementation((...args) => {
    consoleProblems.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args) => {
    consoleProblems.push(args.map(String).join(" "));
  });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    throw new Error(`Unexpected fetch in cockpit test: ${String(input)}`);
  }));
});

afterEach(() => {
  cleanup();
  if (consoleProblems.length > 0) {
    throw new Error(`Unexpected console output in cockpit test:\n${consoleProblems.join("\n")}`);
  }
  vi.restoreAllMocks();
});

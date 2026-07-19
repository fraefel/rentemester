import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";

const executable = (path: string) => (statSync(path).mode & 0o111) !== 0;

describe("package binary contract (#538)", () => {
  test("publishes stable executable wrappers while TypeScript sources stay non-executable", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    expect(packageJson.bin).toEqual({
      rentemester: "./bin/rentemester",
      "rentemester-mcp": "./bin/rentemester-mcp",
    });

    expect(readFileSync("bin/rentemester", "utf8")).toStartWith("#!/usr/bin/env bun\n");
    expect(readFileSync("bin/rentemester-mcp", "utf8")).toStartWith("#!/usr/bin/env bun\n");
    expect(executable("bin/rentemester")).toBe(true);
    expect(executable("bin/rentemester-mcp")).toBe(true);
    expect(executable("src/cli.ts")).toBe(false);
    expect(executable("src/mcp/server.ts")).toBe(false);
  });
});

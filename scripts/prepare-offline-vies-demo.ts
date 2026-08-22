#!/usr/bin/env bun
/** Create the demo-only offline VIES marker immediately after CLI init. */
import { writeOfflineViesDemoMarker } from "../src/core/offline-vies-demo";

const companyRoot = Bun.argv[2];
if (!companyRoot) {
  console.error("Usage: bun run scripts/prepare-offline-vies-demo.ts <company-root>");
  process.exitCode = 2;
} else {
  try {
    writeOfflineViesDemoMarker(companyRoot);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "could not prepare offline VIES demo marker");
    process.exitCode = 2;
  }
}

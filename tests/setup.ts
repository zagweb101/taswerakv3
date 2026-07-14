// ====================================================================
// Vitest setup — runs before every test file.
// Provides a fresh process.env sandbox for env-validation tests.
// ====================================================================

import { beforeEach, vi } from "vitest";

beforeEach(() => {
  // Reset env between tests
  vi.unstubAllEnvs();
});

// Mock console.error / console.warn to keep test output clean by default.
// Individual tests can restore them if they want to assert on output.
const origError = console.error;
const origWarn = console.warn;
console.error = (...args: any[]) => {
  if (process.env.VERBOSE === "1") origError(...args);
};
console.warn = (...args: any[]) => {
  if (process.env.VERBOSE === "1") origWarn(...args);
};

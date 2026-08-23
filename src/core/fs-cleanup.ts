import { renameSync, rmSync, type RmOptions } from "node:fs";

export type ClosableResource = { close(): void };

export type CleanupRetryOptions = {
  maxAttempts?: number;
  sleep?: (milliseconds: number) => void;
};

const TRANSIENT_WINDOWS_CLEANUP_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
// Windows can keep recently closed SQLite and antivirus-scanned files busy for
// noticeably longer than one scheduler tick. Keep the retry window bounded,
// but long enough (1.585 seconds total) for those handles to be released.
const DEFAULT_BACKOFF_MS = [10, 25, 50, 100, 200, 400, 800] as const;

function defaultSleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isTransientWindowsCleanupError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error &&
      typeof error.code === "string" && TRANSIENT_WINDOWS_CLEANUP_CODES.has(error.code),
  );
}

/** Runs a synchronous cleanup operation with a small, bounded retry budget. */
export function retryTransientCleanup<T>(operation: () => T, options: CleanupRetryOptions = {}): T {
  const maxAttempts = options.maxAttempts ?? DEFAULT_BACKOFF_MS.length + 1;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isTransientWindowsCleanupError(error) || attempt >= maxAttempts) throw error;
      sleep(DEFAULT_BACKOFF_MS[Math.min(attempt - 1, DEFAULT_BACKOFF_MS.length - 1)]!);
    }
  }
}

/** Removes exactly `path`; it never expands the caller's deletion target. */
export function removePathWithRetry(path: string, options: RmOptions = { recursive: true, force: true }): void {
  retryTransientCleanup(() => rmSync(path, options));
}

/** Atomically moves one exact path, retrying only transient Windows locks. */
export function renamePathWithRetry(source: string, destination: string): void {
  retryTransientCleanup(() => renameSync(source, destination));
}

/** Closes an owning resource before attempting its filesystem cleanup. */
export function closeThenCleanup(resource: ClosableResource | undefined, cleanup: () => void): void {
  resource?.close();
  cleanup();
}

export function closeThenRemovePath(resource: ClosableResource | undefined, path: string, options: RmOptions = { recursive: true, force: true }): void {
  closeThenCleanup(resource, () => removePathWithRetry(path, options));
}

// A minimal data-fetching hook. The cockpit has a handful of read endpoints
// and no caching needs, so a tiny `loading | error | data` state machine —
// with a `reload` to re-run after a mutation — is all that is warranted.

import { useCallback, useEffect, useRef, useState } from "react";

export type AsyncState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Re-runs the loader; used after a mutation invalidates the data. */
  reload: () => void;
};

export function useAsync<T>(
  loader: () => Promise<T>,
  deps: readonly unknown[],
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // Keep the latest loader without making it a hook dependency.
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    // Reading the generation makes reloads an explicit effect input.
    void tick;
    let cancelled = false;
    setLoading(true);
    setError(null);
    loaderRef.current()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, reload };
}

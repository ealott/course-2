import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "x-haulsplit": "1" };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: payload, credentials: "same-origin" });
  } catch {
    throw new ApiError("Couldn't reach the server. Check your connection.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Something went wrong (${res.status}).`, res.status);
  return data as T;
}

interface Loaded<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (fn: (prev: T | null) => T | null) => void;
}

/** GETs a path, optionally re-polling it while the tab is visible. */
export function useApi<T>(path: string | null, options: { poll?: number; paused?: boolean } = {}): Loaded<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const pausedRef = useRef(options.paused ?? false);
  pausedRef.current = options.paused ?? false;

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      const next = await api<T>("GET", path);
      setDataState(next);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(String(err), 0));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setLoading(true);
    setDataState(null);
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!options.poll || !path) return;
    const tick = () => {
      if (document.visibilityState === "visible" && !pausedRef.current) void reload();
    };
    const id = window.setInterval(tick, options.poll);
    const onVisible = () => document.visibilityState === "visible" && tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [options.poll, path, reload]);

  const setData = useCallback((fn: (prev: T | null) => T | null) => setDataState((prev) => fn(prev)), []);

  return { data, error, loading, reload, setData };
}

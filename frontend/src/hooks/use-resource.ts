import { useEffect, useState } from "react";
import { api } from "../lib/api";
export function useResource<T>(path: string, revision = 0) {
  const [state, setState] = useState<{
    data?: T;
    error?: string;
    loading: boolean;
  }>({ loading: true });
  useEffect(() => {
    const controller = new AbortController();
    setState(previous => ({ data: previous.data, loading: true }));
    api<T>(path, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setState({ data, loading: false });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState({ error: error.message, loading: false });
      });
    return () => controller.abort();
  }, [path, revision]);
  return state;
}

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import type { Me } from "../shared/api";
import { api } from "./api";
import { Loading } from "./ui";

interface Session {
  me: Me | null;
  ready: boolean;
  setMe: (me: Me | null) => void;
  refresh: () => Promise<void>;
  config: { aiReceipts: boolean };
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [config, setConfig] = useState({ aiReceipts: false });

  const refresh = useCallback(async () => {
    try {
      const res = await api<{ me: Me | null }>("GET", "/session");
      setMe(res.me);
    } catch {
      // Offline or server error: keep whatever we had.
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    api<{ aiReceipts: boolean }>("GET", "/config").then(setConfig, () => {});
  }, [refresh]);

  return <SessionContext.Provider value={{ me, ready, setMe, refresh, config }}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("SessionProvider missing");
  return ctx;
}

export function useMe(): Me {
  const { me } = useSession();
  if (!me) throw new Error("Not logged in");
  return me;
}

/** Renders children only when logged in; otherwise sends people to log in and come back. */
export function RequireMe({ children }: { children: ReactNode }) {
  const { me, ready } = useSession();
  const location = useLocation();
  if (!ready) return <Loading />;
  if (!me) return <Navigate to={`/welcome?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <>{children}</>;
}

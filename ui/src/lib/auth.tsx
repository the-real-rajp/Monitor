/* eslint-disable react-refresh/only-export-components -- hooks live beside the provider */
import { createContext, useContext, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useLocation } from "react-router-dom";
import { api, ApiError, type Me } from "../api/client";

interface AuthState {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);
export const ME_KEY = ["me"] as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return await api.get<Me>("/api/auth/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
  const value: AuthState = {
    me: q.data ?? null,
    loading: q.isLoading,
    refresh: async () => {
      await qc.invalidateQueries({ queryKey: ME_KEY });
    },
    logout: async () => {
      await api.post("/api/auth/logout");
      qc.clear();
      qc.setQueryData(ME_KEY, null);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}

export function RequireAuth({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="page-loading">Loading…</div>;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (admin && me.user.role !== "admin") return <Navigate to="/" replace />;
  return <>{children}</>;
}

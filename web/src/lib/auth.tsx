/* eslint-disable react-refresh/only-export-components -- hooks and helpers live beside the provider */
import { createContext, useContext, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useLocation } from "react-router-dom";
import { api, type Me } from "../api/client";

interface AuthState {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export const ME_KEY = ["me"] as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      const { data, response } = await api.GET("/api/v1/auth/me");
      if (response.status === 401) return null;
      if (!data) throw new Error(`unexpected ${response.status}`);
      return data;
    },
  });

  const value: AuthState = {
    me: q.data ?? null,
    loading: q.isLoading,
    refresh: async () => {
      await qc.invalidateQueries({ queryKey: ME_KEY });
    },
    logout: async () => {
      await api.POST("/api/v1/auth/logout");
      qc.setQueryData(ME_KEY, null);
      qc.clear();
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

/** Wraps routes that need a logged-in user. */
export function RequireAuth({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <p className="muted">Loading…</p>;
  if (!me?.user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (admin && me.user.role !== "admin") return <Navigate to="/" replace />;
  return <>{children}</>;
}

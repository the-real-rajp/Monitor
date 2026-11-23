/* eslint-disable react-refresh/only-export-components -- hooks live beside the provider */
import { createContext, useContext, useState, type ReactNode } from "react";
import { useAuth } from "./auth";

/** Auto-refresh choices in seconds; 0 is off. Mirrors Settings::REFRESH_CHOICES. */
export const REFRESH_CHOICES = [0, 10, 30, 60, 300] as const;

export function refreshLabel(seconds: number): string {
  if (seconds === 0) return "off";
  return seconds < 60 ? `${seconds} s` : `${seconds / 60} min`;
}

/** "default" follows the site-wide setting; a number is this browser's own choice. */
export type RefreshChoice = "default" | number;

interface RefreshState {
  choice: RefreshChoice;
  setChoice: (c: RefreshChoice) => void;
  /** The site-wide default, in seconds. */
  siteDefault: number;
  /** For react-query's refetchInterval: milliseconds, or false when off. */
  ms: number | false;
  /** The same, but never faster than once a minute, for data that changes slowly. */
  slowMs: number | false;
}

const KEY = "monitor.refresh";
const Ctx = createContext<RefreshState | null>(null);

function stored(): RefreshChoice {
  try {
    const n = Number(localStorage.getItem(KEY) ?? "default");
    return (REFRESH_CHOICES as readonly number[]).includes(n) ? n : "default";
  } catch {
    return "default";
  }
}

export function RefreshProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const [choice, setChoiceState] = useState<RefreshChoice>(stored);
  const siteDefault = me?.refresh_default_s ?? 10;
  const seconds = choice === "default" ? siteDefault : choice;
  const value: RefreshState = {
    choice,
    siteDefault,
    setChoice: (c) => {
      setChoiceState(c);
      try {
        if (c === "default") localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, String(c));
      } catch {
        // Private browsing: the choice lasts until the tab closes.
      }
    },
    ms: seconds > 0 ? seconds * 1000 : false,
    slowMs: seconds > 0 ? Math.max(seconds, 60) * 1000 : false,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRefresh(): RefreshState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useRefresh outside RefreshProvider");
  return v;
}

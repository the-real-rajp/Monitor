import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../lib/auth";
import CronBanner from "./CronBanner";
import { REFRESH_CHOICES, refreshLabel, useRefresh } from "../lib/refresh";

export function Logo() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="var(--accent)" />
      <path
        d="M4.5 15.5l4-5.5 3.5 3.5 3-6.5 4.5 8.5"
        fill="none"
        stroke="var(--on-accent)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function Layout() {
  const { me, logout } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const fetching = useIsFetching() > 0;
  const { choice, setChoice, siteDefault } = useRefresh();
  const isAdmin = me?.user.role === "admin";
  const initials = (me?.user.name ?? "?")
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 2);

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          <Logo /> Monitor
        </Link>
        <nav className="nav" aria-label="Main">
          <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>
            Overview
          </NavLink>
          {isAdmin && (
            <NavLink to="/devices" end className={({ isActive }) => (isActive ? "active" : "")}>
              Devices
            </NavLink>
          )}
          {isAdmin && (
            <NavLink to="/proxies" className={({ isActive }) => (isActive ? "active" : "")}>
              Proxies
            </NavLink>
          )}
          {isAdmin && (
            <NavLink to="/settings" className={({ isActive }) => (isActive ? "active" : "")}>
              Settings
            </NavLink>
          )}
        </nav>
        <div className="spacer" />
        <div className="row topbar-tools">
          <select
            className="refresh-select"
            aria-label="Auto-refresh"
            title="How often this page reloads its data. Saved in this browser."
            value={choice}
            onChange={(e) =>
              setChoice(e.target.value === "default" ? "default" : Number(e.target.value))
            }
          >
            <option value="default">Auto-refresh: {refreshLabel(siteDefault)} (default)</option>
            {REFRESH_CHOICES.map((s) => (
              <option key={s} value={s}>
                Auto-refresh: {refreshLabel(s)}
              </option>
            ))}
          </select>
          <button
            className="btn sm refresh-now"
            onClick={() => void qc.invalidateQueries()}
            disabled={fetching}
            title="Reload the data on this page now"
          >
            {fetching ? "Refreshing…" : "Refresh"}
          </button>
          <Link
            to="/account"
            className="avatar"
            aria-label="Account"
            style={{ display: "grid", placeItems: "center" }}
          >
            {initials}
          </Link>
          <button
            className="btn sm hide-sm"
            onClick={async () => {
              await logout();
              nav("/login");
            }}
          >
            Log out
          </button>
        </div>
      </header>
      <main className="page">
        <CronBanner />
        <Outlet />
      </main>
    </>
  );
}

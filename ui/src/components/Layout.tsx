import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

export function Logo() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#2457D6" />
      <path
        d="M4.5 15.5l4-5.5 3.5 3.5 3-6.5 4.5 8.5"
        fill="none"
        stroke="#fff"
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
        </nav>
        <div className="spacer" />
        <div className="row" style={{ gap: 8 }}>
          <Link
            to="/account"
            className="avatar"
            aria-label="Account"
            style={{ display: "grid", placeItems: "center" }}
          >
            {initials}
          </Link>
          <button
            className="btn sm"
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
        <Outlet />
      </main>
    </>
  );
}

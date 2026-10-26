import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

export default function Layout() {
  const { me, logout } = useAuth();
  const nav = useNavigate();
  const user = me?.user;
  const isAdmin = user?.role === "admin";

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">Monitor</div>
        <NavLink to="/" end className={({ isActive }) => "nav" + (isActive ? " active" : "")}>
          Overview
        </NavLink>
        <div className="section">Settings</div>
        <NavLink
          to="/settings/account"
          className={({ isActive }) => "nav" + (isActive ? " active" : "")}
        >
          Account
        </NavLink>
        {isAdmin && (
          <>
            <NavLink
              to="/settings/users"
              className={({ isActive }) => "nav" + (isActive ? " active" : "")}
            >
              Users
            </NavLink>
            <NavLink
              to="/settings/api-keys"
              className={({ isActive }) => "nav" + (isActive ? " active" : "")}
            >
              API keys
            </NavLink>
          </>
        )}
        <div className="spacer" />
        <div className="who">
          <div>{user?.name}</div>
          <div>
            {me?.org.name} · {user?.role}
          </div>
          <button
            style={{ marginTop: "0.5rem" }}
            onClick={async () => {
              await logout();
              nav("/login");
            }}
          >
            Log out
          </button>
        </div>
      </aside>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

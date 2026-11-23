import { NavLink, Outlet } from "react-router-dom";

/** The Settings area: a heading, its sections as tabs, and the chosen section. */
export default function SettingsLayout() {
  return (
    <>
      <div className="col" style={{ gap: 12 }}>
        <h1>Settings</h1>
        <nav className="subnav" aria-label="Settings sections">
          <NavLink to="/settings" end className={({ isActive }) => (isActive ? "active" : "")}>
            General
          </NavLink>
          <NavLink to="/settings/users" className={({ isActive }) => (isActive ? "active" : "")}>
            Users
          </NavLink>
        </nav>
      </div>
      <Outlet />
    </>
  );
}

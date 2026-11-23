import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, RequireAuth } from "./lib/auth";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Overview from "./pages/Overview";
import DevicePage from "./pages/Device";
import Devices from "./pages/Devices";
import Agents from "./pages/Agents";
import Account from "./pages/Account";
import Users from "./pages/Users";
import Settings from "./pages/Settings";
import { RefreshProvider } from "./lib/refresh";

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          element={
            <RequireAuth>
              <RefreshProvider>
                <Layout />
              </RefreshProvider>
            </RequireAuth>
          }
        >
          <Route index element={<Overview />} />
          <Route path="devices/:id" element={<DevicePage />} />
          <Route path="account" element={<Account />} />
          <Route
            path="devices"
            element={
              <RequireAuth admin>
                <Devices />
              </RequireAuth>
            }
          />
          <Route
            path="proxies"
            element={
              <RequireAuth admin>
                <Agents />
              </RequireAuth>
            }
          />
          <Route
            path="users"
            element={
              <RequireAuth admin>
                <Users />
              </RequireAuth>
            }
          />
          <Route
            path="settings"
            element={
              <RequireAuth admin>
                <Settings />
              </RequireAuth>
            }
          />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}

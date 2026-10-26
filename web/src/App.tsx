import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, RequireAuth } from "./lib/auth";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Users from "./pages/Users";
import APIKeys from "./pages/APIKeys";
import Account from "./pages/Account";

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="settings/account" element={<Account />} />
          <Route
            path="settings/users"
            element={
              <RequireAuth admin>
                <Users />
              </RequireAuth>
            }
          />
          <Route
            path="settings/api-keys"
            element={
              <RequireAuth admin>
                <APIKeys />
              </RequireAuth>
            }
          />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}

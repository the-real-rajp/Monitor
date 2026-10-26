import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { api, errorMessage } from "../api/client";
import { useAuth } from "../lib/auth";

export default function Login() {
  const { me, loading, refresh } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!loading && me?.user) return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err, response } = await api.POST("/api/v1/auth/login", {
      body: { email, password },
    });
    setBusy(false);
    if (err || !response.ok) {
      setError(errorMessage(err, "Login failed"));
      return;
    }
    await refresh();
    const from = (loc.state as { from?: string } | null)?.from ?? "/";
    nav(from, { replace: true });
  }

  return (
    <div className="login">
      <div className="card">
        <h1>Sign in to Monitor</h1>
        <form className="stack" onSubmit={submit}>
          <label>
            Email
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {error && <div className="error">{error}</div>}
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="muted small" style={{ marginBottom: 0 }}>
          No account yet? An admin creates users, or run <code>monitor-server user create</code> on
          the server.
        </p>
      </div>
    </div>
  );
}

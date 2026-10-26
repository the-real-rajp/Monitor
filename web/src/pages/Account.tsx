import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, errorMessage } from "../api/client";
import { useAuth } from "../lib/auth";

export default function Account() {
  const { me } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const change = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST("/api/v1/auth/password", {
        body: { current_password: current, new_password: next },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirmPw("");
      setError(null);
      setDone(true);
    },
    onError: (e) => {
      setDone(false);
      setError(errorMessage(e));
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== confirmPw) {
      setError("New passwords do not match");
      return;
    }
    change.mutate();
  }

  return (
    <>
      <h1>Account</h1>
      <table style={{ maxWidth: 520 }}>
        <tbody>
          <tr>
            <th style={{ width: "8rem" }}>Name</th>
            <td>{me?.user?.name}</td>
          </tr>
          <tr>
            <th>Email</th>
            <td>{me?.user?.email}</td>
          </tr>
          <tr>
            <th>Role</th>
            <td>{me?.user?.role}</td>
          </tr>
          <tr>
            <th>Organisation</th>
            <td>{me?.org.name}</td>
          </tr>
        </tbody>
      </table>

      <h2>Change password</h2>
      <p className="muted small">Changing your password signs out every other session.</p>
      <form className="stack card" onSubmit={submit}>
        <label>
          Current password
          <input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </label>
        <label>
          New password (min 12 characters)
          <input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            minLength={12}
            required
          />
        </label>
        <label>
          Confirm new password
          <input
            type="password"
            autoComplete="new-password"
            value={confirmPw}
            onChange={(e) => setConfirmPw(e.target.value)}
            required
          />
        </label>
        {error && <div className="error">{error}</div>}
        {done && (
          <div className="small" style={{ color: "var(--ok)" }}>
            Password changed.
          </div>
        )}
        <div>
          <button className="primary" type="submit" disabled={change.isPending}>
            Change password
          </button>
        </div>
      </form>
    </>
  );
}

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
    mutationFn: () =>
      api.post("/api/auth/password", { current_password: current, new_password: next }),
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
      <div className="table-card" style={{ maxWidth: 520 }}>
        <table>
          <tbody>
            <tr>
              <th style={{ width: "8rem" }}>Name</th>
              <td>{me?.user.name}</td>
            </tr>
            <tr>
              <th>Email</th>
              <td>{me?.user.email}</td>
            </tr>
            <tr>
              <th>Role</th>
              <td>{me?.user.role}</td>
            </tr>
            <tr>
              <th>Time zone</th>
              <td>{me?.timezone}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <section className="card col" style={{ maxWidth: 520 }}>
        <h2>Change password</h2>
        <p className="small muted" style={{ margin: 0 }}>
          Changing your password signs out every other session.
        </p>
        <form className="stack" onSubmit={submit}>
          <label className="field">
            Current password
            <input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </label>
          <label className="field">
            New password (at least 12 characters)
            <input
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
          </label>
          <label className="field">
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
          {done && <div className="small ok-ink">Password changed.</div>}
          <button
            className="btn primary"
            type="submit"
            disabled={change.isPending}
            style={{ alignSelf: "flex-start" }}
          >
            Change password
          </button>
        </form>
      </section>
    </>
  );
}

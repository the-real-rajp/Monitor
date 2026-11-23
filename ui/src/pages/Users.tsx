import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, errorMessage, type Role, type User } from "../api/client";
import { useAuth } from "../lib/auth";
import { fmtDateTime } from "../lib/format";

const MIN_PASSWORD = 12;

/** A random password that is easy to read out: no 0/O or 1/l/I. */
function generatePassword(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

function PasswordField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="field" style={{ flex: 2, minWidth: 260 }}>
      Password (at least {MIN_PASSWORD} characters)
      <span className="row" style={{ gap: 8 }}>
        <input
          type="text"
          className="mono"
          autoComplete="off"
          spellCheck={false}
          minLength={MIN_PASSWORD}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          style={{ flex: 1 }}
        />
        <button className="btn" type="button" onClick={() => onChange(generatePassword())}>
          Generate
        </button>
      </span>
    </label>
  );
}

type Editing =
  { mode: "add" } | { mode: "edit"; user: User } | { mode: "password"; user: User } | null;

export default function Users() {
  const qc = useQueryClient();
  const { me, refresh } = useAuth();
  const myId = me?.user.id;
  const q = useQuery({
    queryKey: ["users"],
    queryFn: () => api.get<{ users: User[] }>("/api/users"),
  });
  const [editing, setEditing] = useState<Editing>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ title: string; password?: string } | null>(null);

  const done = (n: { title: string; password?: string } | null) => {
    setEditing(null);
    setError(null);
    setNotice(n);
    void qc.invalidateQueries({ queryKey: ["users"] });
    void refresh(); // the signed-in user's own name may have changed
  };
  const onError = (e: unknown) => setError(errorMessage(e));

  const save = useMutation({
    mutationFn: async (): Promise<{ title: string; password?: string } | null> => {
      if (editing?.mode === "add") {
        await api.post("/api/users", { name, email, role, password });
        return { title: `${name} can now sign in with ${email} and this password.`, password };
      }
      if (editing?.mode === "edit") {
        const self = editing.user.id === myId;
        await api.patch(
          `/api/users/${editing.user.id}`,
          self ? { name, email } : { name, email, role },
        );
        return null;
      }
      if (editing?.mode === "password") {
        await api.post(`/api/users/${editing.user.id}/password`, { password });
        return {
          title: `New password for ${editing.user.name}. They have been signed out everywhere.`,
          password,
        };
      }
      return null;
    },
    onSuccess: done,
    onError,
  });
  const setDisabled = useMutation({
    mutationFn: (u: User) => api.patch(`/api/users/${u.id}`, { disabled: !u.disabled }),
    onSuccess: () => done(null),
    onError,
  });
  const remove = useMutation({
    mutationFn: (u: User) => api.del(`/api/users/${u.id}`),
    onSuccess: () => done(null),
    onError,
  });

  function open(next: Exclude<Editing, null>) {
    setError(null);
    setNotice(null);
    setEditing(next);
    setPassword("");
    if (next.mode === "add") {
      setName("");
      setEmail("");
      setRole("viewer");
    } else {
      setName(next.user.name);
      setEmail(next.user.email);
      setRole(next.user.role);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  const users = q.data?.users ?? [];
  const editingSelf = editing?.mode === "edit" && editing.user.id === myId;

  return (
    <>
      <div className="row between" style={{ alignItems: "flex-end" }}>
        <div>
          <h1>Users</h1>
          <p className="muted" style={{ margin: "4px 0 0", maxWidth: 760 }}>
            People who can sign in to this dashboard. Admins can change devices, proxies and users.
            Viewers can only look.
          </p>
        </div>
        <button className="btn primary" onClick={() => open({ mode: "add" })}>
          Add a user
        </button>
      </div>
      {error && <div className="error">{error}</div>}

      {notice && (
        <div className="notice col" role="status">
          <strong>{notice.title}</strong>
          {notice.password && (
            <>
              <pre className="code">{notice.password}</pre>
              <span className="small muted">
                Pass it on now; it is not shown again. They can change it on their Account page.
              </span>
            </>
          )}
          <button
            className="btn sm"
            onClick={() => setNotice(null)}
            style={{ alignSelf: "flex-start" }}
          >
            Dismiss
          </button>
        </div>
      )}

      {editing && (
        <form className="card col" onSubmit={submit}>
          <h2>
            {editing.mode === "add" && "Add a user"}
            {editing.mode === "edit" && `Edit ${editing.user.name}`}
            {editing.mode === "password" && `New password for ${editing.user.name}`}
          </h2>
          <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
            {editing.mode !== "password" && (
              <>
                <label className="field" style={{ flex: 1, minWidth: 180 }}>
                  Name
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={100}
                    required
                    autoFocus
                  />
                </label>
                <label className="field" style={{ flex: 1, minWidth: 220 }}>
                  Email (used to sign in)
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="off"
                    required
                  />
                </label>
                <label
                  className={editingSelf ? "field disabled" : "field"}
                  style={{ minWidth: 140 }}
                >
                  Role
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value as Role)}
                    disabled={editingSelf}
                  >
                    <option value="viewer">Viewer</option>
                    <option value="admin">Admin</option>
                  </select>
                </label>
              </>
            )}
            {editing.mode !== "edit" && <PasswordField value={password} onChange={setPassword} />}
          </div>
          {editingSelf && (
            <span className="small muted">
              You cannot change your own role. Another admin has to do that.
            </span>
          )}
          {editing.mode === "password" && (
            <span className="small muted">
              Saving signs {editing.user.name} out everywhere. You will see the password once more
              to pass it on.
            </span>
          )}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary" type="submit" disabled={save.isPending}>
              {editing.mode === "add" ? "Create user" : "Save"}
            </button>
            <button className="btn" type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="table-card">
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Added</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const self = u.id === myId;
                return (
                  <tr key={u.id}>
                    <td>
                      <strong>{u.name}</strong> {self && <span className="faint small">(you)</span>}
                    </td>
                    <td>{u.email}</td>
                    <td>
                      <span className={u.role === "admin" ? "pill soft" : "pill"}>
                        {u.role === "admin" ? "Admin" : "Viewer"}
                      </span>
                    </td>
                    <td>
                      {u.disabled ? (
                        <span className="pill danger">Disabled</span>
                      ) : (
                        <span className="pill ok">Active</span>
                      )}
                    </td>
                    <td className="small muted">{fmtDateTime(u.created_at)}</td>
                    <td>
                      <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
                        <button className="btn sm" onClick={() => open({ mode: "edit", user: u })}>
                          Edit
                        </button>
                        {!self && (
                          <>
                            <button
                              className="btn sm"
                              onClick={() => open({ mode: "password", user: u })}
                            >
                              New password
                            </button>
                            <button
                              className="btn sm"
                              onClick={() => {
                                if (
                                  u.disabled ||
                                  confirm(
                                    `Disable ${u.name}? They are signed out and cannot sign in until you enable them again.`,
                                  )
                                )
                                  setDisabled.mutate(u);
                              }}
                            >
                              {u.disabled ? "Enable" : "Disable"}
                            </button>
                            <button
                              className="btn sm danger"
                              onClick={() => {
                                if (
                                  confirm(`Delete ${u.name} (${u.email})? This cannot be undone.`)
                                )
                                  remove.mutate(u);
                              }}
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        To change your own password, use the <Link to="/account">Account</Link> page.
      </p>
    </>
  );
}

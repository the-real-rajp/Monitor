import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, ROLES, type Role, type User } from "../api/client";
import { useAuth } from "../lib/auth";

const USERS_KEY = ["users"] as const;

export default function Users() {
  const qc = useQueryClient();
  const { me } = useAuth();
  const users = useQuery({
    queryKey: USERS_KEY,
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/users");
      if (error) throw error;
      return data.users;
    },
  });
  const [error, setError] = useState<string | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: USERS_KEY });

  const update = useMutation({
    mutationFn: async (args: {
      id: string;
      body: { name?: string; role?: Role; disabled?: boolean; password?: string };
    }) => {
      const { error } = await api.PATCH("/api/v1/users/{id}", {
        params: { path: { id: args.id } },
        body: args.body,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setError(null);
      void invalidate();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE("/api/v1/users/{id}", { params: { path: { id } } });
      if (error) throw error;
    },
    onSuccess: () => {
      setError(null);
      void invalidate();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <>
      <h1>Users</h1>
      {error && <div className="error">{error}</div>}
      {users.isLoading && <p className="muted">Loading…</p>}
      {users.data && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.data.map((u) => (
              <UserRow
                key={u.id}
                user={u}
                self={u.id === me?.user?.id}
                onUpdate={(body) => update.mutate({ id: u.id, body })}
                onDelete={() => {
                  if (confirm(`Delete ${u.email}? This cannot be undone.`)) remove.mutate(u.id);
                }}
              />
            ))}
          </tbody>
        </table>
      )}
      <h2>Add a user</h2>
      <CreateUser
        onCreated={() => {
          setError(null);
          void invalidate();
        }}
      />
    </>
  );
}

function UserRow({
  user,
  self,
  onUpdate,
  onDelete,
}: {
  user: User;
  self: boolean;
  onUpdate: (body: { role?: Role; disabled?: boolean; password?: string }) => void;
  onDelete: () => void;
}) {
  return (
    <tr>
      <td>
        {user.name}
        {self && <span className="muted small"> (you)</span>}
      </td>
      <td>{user.email}</td>
      <td>
        <select
          value={user.role}
          disabled={self}
          onChange={(e) => onUpdate({ role: e.target.value as Role })}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </td>
      <td>
        {user.disabled ? (
          <span className="pill danger">disabled</span>
        ) : (
          <span className="pill ok">active</span>
        )}
      </td>
      <td>
        <div className="row">
          {!self && (
            <button onClick={() => onUpdate({ disabled: !user.disabled })}>
              {user.disabled ? "Enable" : "Disable"}
            </button>
          )}
          <button
            onClick={() => {
              const pw = prompt(`New password for ${user.email} (min 12 characters):`);
              if (pw) onUpdate({ password: pw });
            }}
          >
            Reset password
          </button>
          {!self && (
            <button className="danger" onClick={onDelete}>
              Delete
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function CreateUser({ onCreated }: { onCreated: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST("/api/v1/users", {
        body: { email, name, role, password },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setEmail("");
      setName("");
      setPassword("");
      setError(null);
      onCreated();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <form className="stack card" onSubmit={submit}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label>
        Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <label>
        Role
        <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <label>
        Initial password (min 12 characters)
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={12}
          required
        />
      </label>
      {error && <div className="error">{error}</div>}
      <div>
        <button className="primary" type="submit" disabled={create.isPending}>
          Create user
        </button>
      </div>
    </form>
  );
}

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, SCOPES, type APIKeyCreated, type Scope } from "../api/client";

const KEYS_KEY = ["api-keys"] as const;

export default function APIKeys() {
  const qc = useQueryClient();
  const keys = useQuery({
    queryKey: KEYS_KEY,
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/api-keys");
      if (error) throw error;
      return data.api_keys;
    },
  });
  const [created, setCreated] = useState<APIKeyCreated | null>(null);
  const [error, setError] = useState<string | null>(null);

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE("/api/v1/api-keys/{id}", { params: { path: { id } } });
      if (error) throw error;
    },
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: KEYS_KEY });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <>
      <h1>API keys</h1>
      <p className="muted">
        Collectors and automation authenticate with <code>Authorization: Bearer &lt;key&gt;</code>.
        Keys are shown once, at creation.
      </p>
      {created && (
        <div className="notice">
          <strong>Key created.</strong> Copy it now; it will not be shown again.
          <pre style={{ userSelect: "all", margin: "0.5rem 0 0" }}>
            <code>{created.key}</code>
          </pre>
          <button style={{ marginTop: "0.5rem" }} onClick={() => setCreated(null)}>
            Dismiss
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {keys.data && keys.data.length === 0 && (
        <div className="card empty">
          <h2>No API keys yet</h2>
          <p>Create one below for the first agent or prober.</p>
        </div>
      )}
      {keys.data && keys.data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Prefix</th>
              <th>Scopes</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.data.map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td>
                <td>
                  <code>mon_{k.prefix}_…</code>
                </td>
                <td>{k.scopes.join(", ")}</td>
                <td className="small">{new Date(k.created_at).toLocaleString()}</td>
                <td className="small">
                  {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "never"}
                </td>
                <td>
                  {k.revoked_at ? (
                    <span className="pill danger">revoked</span>
                  ) : (
                    <span className="pill ok">active</span>
                  )}
                </td>
                <td>
                  {!k.revoked_at && (
                    <button
                      className="danger"
                      onClick={() => {
                        if (confirm(`Revoke "${k.name}"? Clients using it will stop working.`))
                          revoke.mutate(k.id);
                      }}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>Create a key</h2>
      <CreateKey
        onCreated={(k) => {
          setCreated(k);
          setError(null);
          void qc.invalidateQueries({ queryKey: KEYS_KEY });
        }}
      />
    </>
  );
}

function CreateKey({ onCreated }: { onCreated: (k: APIKeyCreated) => void }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(["ingest"]);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST("/api/v1/api-keys", { body: { name, scopes } });
      if (error) throw error;
      return data;
    },
    onSuccess: (k) => {
      setName("");
      setError(null);
      onCreated(k);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  function toggle(s: Scope) {
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <form className="stack card" onSubmit={submit}>
      <label>
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. agent on web-1"
          maxLength={100}
          required
        />
      </label>
      <div className="row">
        {SCOPES.map((s) => (
          <label key={s} className="inline">
            <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} />
            {s}
          </label>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      <div>
        <button
          className="primary"
          type="submit"
          disabled={create.isPending || scopes.length === 0}
        >
          Create key
        </button>
      </div>
    </form>
  );
}

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, errorMessage, type Agent } from "../api/client";
import { fmtAgo, fmtDateTime } from "../lib/format";

export default function Agents() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.get<{ agents: Agent[] }>("/api/agents"),
    refetchInterval: 15_000,
  });
  const [created, setCreated] = useState<Agent | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["agents"] });
    void qc.invalidateQueries({ queryKey: ["overview"] });
  };

  const create = useMutation({
    mutationFn: () => api.post<Agent>("/api/agents", { name }),
    onSuccess: (a) => {
      setCreated(a);
      setName("");
      setAdding(false);
      setError(null);
      invalidate();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const rename = useMutation({
    mutationFn: (a: { id: number; name: string }) =>
      api.patch(`/api/agents/${a.id}`, { name: a.name }),
    onSuccess: invalidate,
    onError: (e) => setError(errorMessage(e)),
  });
  const rotate = useMutation({
    mutationFn: (id: number) => api.post<Agent>(`/api/agents/${id}/rotate`),
    onSuccess: (a) => {
      setCreated(a);
      invalidate();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api.del(`/api/agents/${id}`),
    onSuccess: invalidate,
    onError: (e) => setError(errorMessage(e)),
  });

  const agents = q.data?.agents ?? [];
  const active = agents.filter((a) => !a.revoked_at);

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <>
      <div className="row between" style={{ alignItems: "flex-end" }}>
        <div>
          <h1>Proxies</h1>
          <p className="muted" style={{ margin: "4px 0 0", maxWidth: 760 }}>
            A proxy is a small program on a Linux box or Raspberry Pi inside a network. It pings the
            devices you assign to it and reports here. It only makes outbound connections.
          </p>
        </div>
        <button className="btn primary" onClick={() => setAdding(true)}>
          Add a proxy
        </button>
      </div>
      {error && <div className="error">{error}</div>}

      {adding && (
        <form className="card row" onSubmit={submit} style={{ gap: 12 }}>
          <label className="field" style={{ flex: 1, minWidth: 220 }}>
            Proxy name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Office proxy"
              required
              autoFocus
            />
          </label>
          <button
            className="btn primary"
            type="submit"
            disabled={create.isPending}
            style={{ alignSelf: "flex-end" }}
          >
            Create
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => setAdding(false)}
            style={{ alignSelf: "flex-end" }}
          >
            Cancel
          </button>
        </form>
      )}

      {created?.key && (
        <div className="notice col" role="status">
          <strong>Key for “{created.name}”. Copy it now; it is not shown again.</strong>
          <pre className="code">{created.key}</pre>
          <span className="small muted">
            Run this on the Pi (as root) to install or update the proxy:
          </span>
          <pre className="code">{created.install_command}</pre>
          <button
            className="btn sm"
            onClick={() => setCreated(null)}
            style={{ alignSelf: "flex-start" }}
          >
            Dismiss
          </button>
        </div>
      )}

      {q.data && active.length === 0 && !adding && (
        <div className="card empty">
          <h2>No proxies yet</h2>
          <p>
            Create one, then run the install command on a Raspberry Pi or Linux box in your office.
          </p>
        </div>
      )}

      <section
        className="tiles"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))" }}
      >
        {active.map((a) => (
          <article key={a.id} className="card col" style={{ gap: 14 }}>
            <div className="row between" style={{ alignItems: "flex-start" }}>
              <div>
                <h2 style={{ fontSize: 16 }}>{a.name}</h2>
                <div className="small muted mono" style={{ marginTop: 2 }}>
                  key mon_{a.key_prefix}_…
                </div>
              </div>
              {a.online ? (
                <span className="pill ok">
                  <span className="dot up" style={{ width: 8, height: 8 }} /> online
                </span>
              ) : a.last_seen_at ? (
                <span className="pill danger">
                  <span className="dot down" style={{ width: 8, height: 8 }} /> offline
                </span>
              ) : (
                <span className="pill">
                  <span className="dot unknown" style={{ width: 8, height: 8 }} /> never connected
                </span>
              )}
            </div>
            <dl
              style={{
                margin: 0,
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                gap: "10px 16px",
                fontSize: 13,
              }}
            >
              <div>
                <dt className="muted">Last heartbeat</dt>
                <dd style={{ margin: 0, fontWeight: 600 }}>{fmtAgo(a.last_seen_at)}</dd>
              </div>
              <div>
                <dt className="muted">Devices assigned</dt>
                <dd style={{ margin: 0, fontWeight: 600 }}>
                  <Link to="/devices">{a.device_count}</Link>
                </dd>
              </div>
              <div>
                <dt className="muted">Version</dt>
                <dd style={{ margin: 0, fontWeight: 600 }} className="mono">
                  {a.version || "—"}
                </dd>
              </div>
              <div>
                <dt className="muted">Reporting from</dt>
                <dd style={{ margin: 0, fontWeight: 600 }} className="mono">
                  {a.last_ip || "—"}
                </dd>
              </div>
              <div>
                <dt className="muted">Queued results</dt>
                <dd style={{ margin: 0, fontWeight: 600 }}>{a.queue_depth}</dd>
              </div>
              <div>
                <dt className="muted">Registered</dt>
                <dd style={{ margin: 0, fontWeight: 600 }}>{fmtDateTime(a.created_at)}</dd>
              </div>
            </dl>
            <div className="row" style={{ gap: 8 }}>
              <button
                className="btn sm"
                onClick={() => {
                  const n = prompt("Rename proxy", a.name);
                  if (n && n !== a.name) rename.mutate({ id: a.id, name: n });
                }}
              >
                Rename
              </button>
              <button
                className="btn sm"
                onClick={() => {
                  if (
                    confirm(
                      `Rotate the key for "${a.name}"? The old key stops working immediately; you must re-run the install command on the Pi.`,
                    )
                  )
                    rotate.mutate(a.id);
                }}
              >
                Rotate key
              </button>
              <button
                className="btn sm danger"
                onClick={() => {
                  if (
                    confirm(`Revoke "${a.name}"? Its devices are disabled but keep their history.`)
                  )
                    revoke.mutate(a.id);
                }}
              >
                Revoke
              </button>
            </div>
          </article>
        ))}
      </section>

      <section className="card col" style={{ maxWidth: 900 }}>
        <h2>Install on a Raspberry Pi or Linux box</h2>
        <ol style={{ margin: 0, paddingLeft: 20 }} className="col">
          <li>
            Click <strong>Add a proxy</strong> and name it. The key and the exact install command
            are shown once.
          </li>
          <li>
            On the Pi, paste the command. It downloads the right binary for the CPU, writes the
            config, installs a systemd service and starts it.
          </li>
          <li>
            Assign devices to it on the <Link to="/devices">Devices</Link> page. The proxy picks up
            changes within a minute.
          </li>
        </ol>
        <p className="small muted" style={{ margin: 0 }}>
          The proxy needs outbound HTTPS to this site and ICMP on the local network. It buffers up
          to 24 hours of results if this site is unreachable and backfills them with their original
          timestamps.
        </p>
      </section>
    </>
  );
}

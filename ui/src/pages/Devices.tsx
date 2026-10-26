import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { api, errorMessage, INTERVALS, type Agent, type Device, type Group } from "../api/client";
import { fmtDuration } from "../lib/format";

interface Form {
  name: string;
  host: string;
  group_id: number | null;
  source: "agent" | "web";
  agent_id: number | null;
  interval_s: number;
  tcp_fallback_port: number | null;
  enabled: boolean;
  notes: string;
}

const blank = (agents: Agent[]): Form => ({
  name: "",
  host: "",
  group_id: null,
  source: agents.length ? "agent" : "web",
  agent_id: agents[0]?.id ?? null,
  interval_s: agents.length ? 30 : 60,
  tcp_fallback_port: null,
  enabled: true,
  notes: "",
});

export default function Devices() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: () => api.get<{ devices: Device[] }>("/api/devices"),
  });
  const groups = useQuery({
    queryKey: ["groups"],
    queryFn: () => api.get<{ groups: Group[] }>("/api/groups"),
  });
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.get<{ agents: Agent[] }>("/api/agents"),
  });
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<Device | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["devices"] });
    void qc.invalidateQueries({ queryKey: ["overview"] });
    void qc.invalidateQueries({ queryKey: ["groups"] });
  };

  useEffect(() => {
    const id = Number(params.get("edit"));
    if (id && devices.data) {
      const d = devices.data.devices.find((x) => x.id === id);
      if (d) setEditing(d);
    }
  }, [params, devices.data]);

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/devices/${id}`),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const activeAgents = (agents.data?.agents ?? []).filter((a) => !a.revoked_at);
  const list = (devices.data?.devices ?? []).filter(
    (d) =>
      !filter ||
      `${d.name} ${d.host} ${d.group_name ?? ""}`.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="two-col">
      <section className="main col">
        <div className="row between">
          <h1>Devices</h1>
          <div className="row" style={{ gap: 8 }}>
            <input
              type="search"
              placeholder="Filter"
              aria-label="Filter devices"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ width: 180 }}
            />
            <GroupsButton groups={groups.data?.groups ?? []} onChange={invalidate} />
          </div>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="table-card">
          <div className="scroll-x">
            <table style={{ minWidth: 760 }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Host</th>
                  <th>Group</th>
                  <th>Pinged by</th>
                  <th>Every</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((d) => (
                  <tr key={d.id} style={{ opacity: d.enabled ? 1 : 0.6 }}>
                    <td style={{ fontWeight: 600 }}>
                      <Link to={`/devices/${d.id}`} style={{ color: "inherit" }}>
                        {d.name}
                      </Link>
                      {!d.enabled && (
                        <span className="pill" style={{ marginLeft: 8 }}>
                          disabled
                        </span>
                      )}
                    </td>
                    <td className="mono small">{d.host}</td>
                    <td className="muted">{d.group_name ?? "—"}</td>
                    <td className="muted">
                      {d.source === "web"
                        ? `Website${d.tcp_fallback_port ? ` · TCP ${d.tcp_fallback_port}` : ""}`
                        : (d.agent_name ?? "unassigned")}
                    </td>
                    <td className="mono small">{fmtDuration(d.interval_s)}</td>
                    <td>
                      <span className="row" style={{ gap: 6, fontSize: 12, fontWeight: 600 }}>
                        <span className={`dot ${d.status.state}`} />
                        {d.status.state}
                      </span>
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn sm" onClick={() => setEditing(d)}>
                        Edit
                      </button>{" "}
                      <button
                        className="btn sm danger"
                        onClick={() => {
                          if (confirm(`Delete ${d.name} and all of its history?`))
                            remove.mutate(d.id);
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
                {devices.data && list.length === 0 && (
                  <tr>
                    <td colSpan={7} className="empty">
                      {filter ? "No devices match." : "No devices yet. Add one on the right."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="foot">
            {devices.data?.devices.length ?? 0} devices · disabled devices keep their history
          </div>
        </div>
      </section>

      <aside className="side card col" aria-label={editing ? "Edit device" : "Add a device"}>
        <div className="row between">
          <h2>{editing ? `Edit ${editing.name}` : "Add a device"}</h2>
          {editing && (
            <button
              className="btn sm"
              onClick={() => {
                setEditing(null);
                setParams({});
              }}
            >
              Cancel
            </button>
          )}
        </div>
        {agents.data && groups.data && (
          <DeviceForm
            key={editing?.id ?? "new"}
            editing={editing}
            agents={activeAgents}
            groups={groups.data.groups}
            onDone={() => {
              setEditing(null);
              setParams({});
              invalidate();
            }}
          />
        )}
      </aside>
    </div>
  );
}

function DeviceForm({
  editing,
  agents,
  groups,
  onDone,
}: {
  editing: Device | null;
  agents: Agent[];
  groups: Group[];
  onDone: () => void;
}) {
  const [f, setF] = useState<Form>(
    editing
      ? {
          name: editing.name,
          host: editing.host,
          group_id: editing.group_id,
          source: editing.source,
          agent_id: editing.agent_id,
          interval_s: editing.interval_s,
          tcp_fallback_port: editing.tcp_fallback_port,
          enabled: editing.enabled,
          notes: editing.notes ?? "",
        }
      : blank(agents),
  );
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((cur) => ({ ...cur, [k]: v }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...f,
        notes: f.notes.trim() === "" ? null : f.notes,
        tcp_fallback_port: f.source === "web" ? f.tcp_fallback_port : null,
        agent_id: f.source === "agent" ? f.agent_id : null,
      };
      return editing
        ? api.patch(`/api/devices/${editing.id}`, body)
        : api.post("/api/devices", body);
    },
    onSuccess: () => {
      setError(null);
      onDone();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  const intervals = INTERVALS.filter((i) => f.source === "agent" || i >= 60);

  return (
    <form className="stack" onSubmit={submit}>
      <label className="field">
        Name
        <input
          type="text"
          value={f.name}
          onChange={(e) => set("name", e.target.value)}
          required
          maxLength={100}
        />
      </label>
      <label className="field">
        Host or IP address
        <input
          type="text"
          className="mono"
          value={f.host}
          onChange={(e) => set("host", e.target.value)}
          required
        />
      </label>
      <label className="field">
        Group
        <select
          value={f.group_id ?? ""}
          onChange={(e) => set("group_id", e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">Ungrouped</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </label>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="col">
        <legend className="field" style={{ padding: 0, marginBottom: 6 }}>
          Pinged by
        </legend>
        <label className={`radio-card ${f.source === "agent" ? "selected" : ""}`}>
          <input
            type="radio"
            name="source"
            checked={f.source === "agent"}
            disabled={agents.length === 0}
            onChange={() => {
              set("source", "agent");
              if (f.interval_s >= 60) set("interval_s", 30);
            }}
          />
          <span>
            <strong>A proxy</strong>
            <br />
            <span className="small muted">
              {agents.length === 0
                ? "No proxies yet. Add one on the Proxies page."
                : "For devices on the office network. ICMP, intervals from 10s."}
            </span>
          </span>
        </label>
        <label className={`radio-card ${f.source === "web" ? "selected" : ""}`}>
          <input
            type="radio"
            name="source"
            checked={f.source === "web"}
            onChange={() => {
              set("source", "web");
              if (f.interval_s < 60) set("interval_s", 60);
            }}
          />
          <span>
            <strong>The website</strong>
            <br />
            <span className="small muted">
              For internet-facing devices. Every 60s or slower. Set a TCP port in case ICMP is
              blocked on the host.
            </span>
          </span>
        </label>
      </fieldset>
      {f.source === "agent" && (
        <label className="field">
          Proxy
          <select
            value={f.agent_id ?? ""}
            onChange={(e) => set("agent_id", Number(e.target.value))}
            required
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
        <label className="field">
          Interval
          <select value={f.interval_s} onChange={(e) => set("interval_s", Number(e.target.value))}>
            {intervals.map((i) => (
              <option key={i} value={i}>
                {fmtDuration(i)}
              </option>
            ))}
          </select>
        </label>
        <label className={`field ${f.source === "web" ? "" : "disabled"}`}>
          TCP port (website only)
          <input
            type="number"
            min={1}
            max={65535}
            placeholder="443"
            disabled={f.source !== "web"}
            value={f.tcp_fallback_port ?? ""}
            onChange={(e) =>
              set("tcp_fallback_port", e.target.value ? Number(e.target.value) : null)
            }
          />
        </label>
      </div>
      <label className="field">
        Notes
        <input
          type="text"
          value={f.notes}
          onChange={(e) => set("notes", e.target.value)}
          maxLength={2000}
        />
      </label>
      {editing && (
        <label className="row" style={{ gap: 8, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={f.enabled}
            onChange={(e) => set("enabled", e.target.checked)}
          />{" "}
          Enabled
        </label>
      )}
      {error && <div className="error">{error}</div>}
      <button className="btn primary" type="submit" disabled={save.isPending}>
        {editing ? "Save changes" : "Add device"}
      </button>
    </form>
  );
}

function GroupsButton({ groups, onChange }: { groups: Group[]; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.post("/api/groups", { name }),
    onSuccess: () => {
      setName("");
      setError(null);
      onChange();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const rename = useMutation({
    mutationFn: (g: { id: number; name: string }) =>
      api.patch(`/api/groups/${g.id}`, { name: g.name }),
    onSuccess: onChange,
    onError: (e) => setError(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/groups/${id}`),
    onSuccess: onChange,
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <>
      <button className="btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Manage groups
      </button>
      {open && (
        <div
          className="card col"
          style={{ position: "absolute", zIndex: 5, marginTop: 44, width: 320 }}
        >
          <h2>Groups</h2>
          {groups.map((g) => (
            <div key={g.id} className="row between">
              <span>
                {g.name} <span className="faint small">({g.device_count})</span>
              </span>
              <span className="row" style={{ gap: 4 }}>
                <button
                  className="btn sm"
                  onClick={() => {
                    const n = prompt("Rename group", g.name);
                    if (n && n !== g.name) rename.mutate({ id: g.id, name: n });
                  }}
                >
                  Rename
                </button>
                <button
                  className="btn sm danger"
                  onClick={() => {
                    if (confirm(`Delete group "${g.name}"? Its devices become ungrouped.`))
                      remove.mutate(g.id);
                  }}
                >
                  Delete
                </button>
              </span>
            </div>
          ))}
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <input
              type="text"
              placeholder="New group"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              style={{ flex: 1 }}
            />
            <button className="btn primary" type="submit" disabled={create.isPending}>
              Add
            </button>
          </form>
          {error && <div className="error">{error}</div>}
          <button className="btn sm" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      )}
    </>
  );
}

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, errorMessage, type Device, type Group } from "../api/client";
import DeviceDialog from "../components/DeviceDialog";
import { fmtDuration } from "../lib/format";
import { useRefresh } from "../lib/refresh";

export default function Devices() {
  const qc = useQueryClient();
  const { ms } = useRefresh();
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: () => api.get<{ devices: Device[] }>("/api/devices"),
    refetchInterval: ms,
  });
  const groups = useQuery({
    queryKey: ["groups"],
    queryFn: () => api.get<{ groups: Group[] }>("/api/groups"),
  });
  const [filter, setFilter] = useState("");
  /** The dialog: a device being edited, "new" to add, or null when closed. */
  const [dialog, setDialog] = useState<Device | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["devices"] });
    void qc.invalidateQueries({ queryKey: ["overview"] });
    void qc.invalidateQueries({ queryKey: ["groups"] });
  };

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/devices/${id}`),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const list = (devices.data?.devices ?? []).filter(
    (d) =>
      !filter ||
      `${d.name} ${d.host} ${d.group_name ?? ""}`.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <>
      <section className="col">
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
            <button className="btn primary" onClick={() => setDialog("new")}>
              Add devices
            </button>
          </div>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="table-card">
          <div className="scroll-x">
            <table className="dense" style={{ minWidth: 600 }}>
              <thead>
                <tr>
                  <th>Device</th>
                  <th>Group</th>
                  <th>Pinged by</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((d) => (
                  <tr key={d.id} style={{ opacity: d.enabled ? 1 : 0.6 }}>
                    <td>
                      <div className="dev-name">
                        <span
                          className={`dot ${d.status.state}`}
                          role="img"
                          aria-label={d.status.state}
                        />
                        <Link to={`/devices/${d.id}`} style={{ color: "inherit" }}>
                          {d.name}
                        </Link>
                        {!d.enabled && <span className="pill">disabled</span>}
                      </div>
                      <div className="dev-host">{d.host}</div>
                    </td>
                    <td className="muted">{d.group_name ?? "—"}</td>
                    <td className="muted">
                      {d.source === "web"
                        ? `The website${d.tcp_fallback_port ? `, TCP ${d.tcp_fallback_port}` : ""}`
                        : (d.agent_name ?? "unassigned")}
                      , every {fmtDuration(d.interval_s)}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn sm" onClick={() => setDialog(d)}>
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
                    <td colSpan={4} className="empty">
                      {filter
                        ? "No devices match."
                        : "No devices yet. Choose Add devices to start."}
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

      {dialog && (
        <DeviceDialog
          key={dialog === "new" ? "new" : dialog.id}
          device={dialog === "new" ? null : dialog}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

/** Common groups offered for one-click adding, by area. Nothing is created until asked. */
const SUGGESTED_GROUPS: { area: string; names: string[] }[] = [
  {
    area: "Network",
    names: ["Firewalls", "Routers", "Switches", "Wireless", "Internet", "VPN", "Load Balancers"],
  },
  {
    area: "Infrastructure",
    names: [
      "Hypervisors",
      "Storage",
      "Backup",
      "Out-of-Band Management",
      "UPS & Power",
      "Environmental Sensors",
    ],
  },
  {
    area: "Servers",
    names: [
      "Windows Servers",
      "Linux Servers",
      "Domain Controllers",
      "Database Servers",
      "File Servers",
      "Web Servers",
      "Mail Servers",
      "Application Servers",
    ],
  },
  {
    area: "Services",
    names: ["DNS", "DHCP", "NTP", "Websites", "Cloud Services", "Remote Access"],
  },
  {
    area: "Endpoints",
    names: ["Workstations", "Printers", "Phones", "Cameras", "Door Access"],
  },
];

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
  // One at a time, so the groups keep the order they are listed in.
  const addSuggested = useMutation({
    mutationFn: async (names: string[]) => {
      for (const n of names) await api.post("/api/groups", { name: n });
    },
    onSuccess: () => setError(null),
    onError: (e) => setError(errorMessage(e)),
    onSettled: onChange,
  });
  const existing = new Set(groups.map((g) => g.name.trim().toLowerCase()));
  const suggestions = SUGGESTED_GROUPS.map((g) => ({
    area: g.area,
    names: g.names.filter((n) => !existing.has(n.toLowerCase())),
  })).filter((g) => g.names.length > 0);
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
    <span style={{ position: "relative" }}>
      <button className="btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Manage groups
      </button>
      {open && (
        <div
          className="card col"
          style={{
            position: "absolute",
            zIndex: 5,
            top: "calc(100% + 8px)",
            right: 0,
            width: 460,
            maxWidth: "92vw",
            maxHeight: "calc(100vh - 170px)",
            overflowY: "auto",
          }}
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
          {suggestions.length > 0 && (
            <div className="col" style={{ gap: 10 }}>
              <span className="small muted">Suggested groups. Click one to add it.</span>
              {suggestions.map((g) => (
                <div key={g.area} className="col" style={{ gap: 6 }}>
                  <div className="row between">
                    <strong className="small">{g.area}</strong>
                    <button
                      className="btn sm"
                      onClick={() => addSuggested.mutate(g.names)}
                      disabled={addSuggested.isPending}
                      aria-label={`Add all ${g.area} groups`}
                    >
                      Add all {g.names.length}
                    </button>
                  </div>
                  <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    {g.names.map((n) => (
                      <button
                        key={n}
                        className="btn sm"
                        onClick={() => addSuggested.mutate([n])}
                        disabled={addSuggested.isPending}
                        aria-label={`Add group ${n}`}
                      >
                        + {n}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {error && <div className="error">{error}</div>}
          <button className="btn sm" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      )}
    </span>
  );
}

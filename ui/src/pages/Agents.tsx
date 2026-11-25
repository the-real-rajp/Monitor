import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, errorMessage, type Agent } from "../api/client";
import { fmtAgo, fmtDateTime } from "../lib/format";
import { useRefresh } from "../lib/refresh";

const VM_SCRIPTS = {
  ahv: "New-MonitorProxyVM-AHV.ps1",
  vmware: "New-MonitorProxyVM-VMware.ps1",
};

/** Download links for the scripts that create a proxy VM. They hold no secrets. */
function VmScripts() {
  return (
    <div className="row" style={{ gap: 8 }}>
      <a className="btn sm" href={`/vm/${VM_SCRIPTS.ahv}`} download>
        Download AHV script
      </a>
      <a className="btn sm" href={`/vm/${VM_SCRIPTS.vmware}`} download>
        Download VMware script
      </a>
    </div>
  );
}

/** First-boot file for running the proxy as a VM instead of on a Pi. */
function VmSetup({ name, userData }: { name: string; userData: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (label: string, text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    });
  };
  const fileName = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "proxy"}-user-data.yaml`;
  const download = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([userData], { type: "text/yaml" }));
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <details>
      <summary>
        <strong>Or run it as a VM (Nutanix AHV, VMware)</strong>
      </summary>
      <div className="col" style={{ marginTop: 10 }}>
        <span className="small muted">
          Create a VM from the Ubuntu Server cloud image and give it this cloud-init user data. It
          installs the proxy on first boot; nothing to type on the VM. AHV takes the text as the
          cloud-init custom script. The Ubuntu OVA on vSphere wants the base64 form in its “Encoded
          user-data” field. The file contains the key above.
        </span>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn sm" onClick={() => copy("text", userData)}>
            {copied === "text" ? "Copied" : "Copy for AHV"}
          </button>
          <button className="btn sm" onClick={() => copy("b64", btoa(userData))}>
            {copied === "b64" ? "Copied" : "Copy base64 for VMware"}
          </button>
          <button className="btn sm" onClick={download}>
            Download user-data.yaml
          </button>
        </div>
        <pre className="code" style={{ maxHeight: 260, overflowY: "auto" }}>
          {userData}
        </pre>
        <strong>Let a script build the VM</strong>
        <span className="small muted">
          These PowerShell 7 scripts download the Ubuntu image, create the VM with the file above
          and power it on. Download the file and a script into one folder, then run the matching
          command there with your own names filled in.
        </span>
        <VmScripts />
        <pre className="code">
          {`# Nutanix AHV, through Prism Central. It asks for everything with numbered choices.
./${VM_SCRIPTS.ahv}

# VMware, through vCenter. It asks for everything with numbered choices.
./${VM_SCRIPTS.vmware}`}
        </pre>
      </div>
    </details>
  );
}

export default function Agents() {
  const qc = useQueryClient();
  const { ms } = useRefresh();
  const q = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.get<{ agents: Agent[] }>("/api/agents"),
    refetchInterval: ms,
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
          {created.cloud_init && <VmSetup name={created.name} userData={created.cloud_init} />}
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

      {active.length > 0 && (
        <section className="table-card" aria-label="Proxies">
          <div className="scroll-x">
            <table className="dense stack-sm">
              <thead>
                <tr>
                  <th>Proxy</th>
                  <th>Status</th>
                  <th>Devices</th>
                  <th>Version</th>
                  <th>Reporting from</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {active.map((a) => {
                  const state = a.online ? "up" : a.last_seen_at ? "down" : "unknown";
                  return (
                    <tr key={a.id}>
                      <td>
                        <div className="dev-name">
                          <span className={`dot ${state}`} />
                          {a.name}
                        </div>
                        <div className="dev-host">
                          key mon_{a.key_prefix}_…, added {fmtDateTime(a.created_at)}
                        </div>
                      </td>
                      <td>
                        {a.online ? (
                          <>Online, heard from {fmtAgo(a.last_seen_at)}</>
                        ) : a.last_seen_at ? (
                          <span className="danger-ink" style={{ fontWeight: 600 }}>
                            Offline, last heard from {fmtAgo(a.last_seen_at)}
                          </span>
                        ) : (
                          <span className="muted">Never connected</span>
                        )}
                        {a.queue_depth > 0 && (
                          <div className="small muted">{a.queue_depth} results waiting to send</div>
                        )}
                      </td>
                      <td className="num" data-label="Devices" style={{ textAlign: "left" }}>
                        <Link to="/devices">{a.device_count}</Link>
                      </td>
                      <td className="mono small" data-label="Version">
                        {a.version || "—"}
                      </td>
                      <td className="mono small" data-label="Reporting from">
                        {a.last_ip || "—"}
                      </td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
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
                              confirm(
                                `Revoke "${a.name}"? Its devices are disabled but keep their history.`,
                              )
                            )
                              revoke.mutate(a.id);
                          }}
                        >
                          Revoke
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

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
          No Pi to hand? The same proxy runs as a small VM on Nutanix AHV or VMware: after you add a
          proxy, open <strong>Or run it as a VM</strong> under its key for a ready-made first-boot
          file. These PowerShell 7 scripts then create the VM for you:
        </p>
        <VmScripts />
        <p className="small muted" style={{ margin: 0 }}>
          The proxy needs outbound HTTPS to this site and ICMP on the local network. It buffers up
          to 24 hours of results if this site is unreachable and backfills them with their original
          timestamps.
        </p>
      </section>
    </>
  );
}

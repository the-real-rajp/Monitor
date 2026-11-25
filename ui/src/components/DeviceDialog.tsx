import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, errorMessage, INTERVALS, type Agent, type Device, type Group } from "../api/client";
import { fmtDuration } from "../lib/format";
import { hostProblem, parseBulk } from "../lib/hosts";

/** How a device is checked. Shared by the single form and the bulk form. */
interface Checks {
  /** A group id, null for ungrouped, or "new" while naming a group that does not exist yet. */
  group: number | null | "new";
  newGroup: string;
  source: "agent" | "web";
  agent_id: number | null;
  interval_s: number;
  tcp_fallback_port: number | null;
}

const defaultChecks = (agents: Agent[]): Checks => ({
  group: null,
  newGroup: "",
  source: agents.length ? "agent" : "web",
  agent_id: agents[0]?.id ?? null,
  interval_s: agents.length ? 30 : 60,
  tcp_fallback_port: null,
});

/**
 * Add one device, add several at once, or edit one. Opens over whatever page
 * asked for it, takes focus, and closes on Escape.
 */
export default function DeviceDialog({
  device,
  onClose,
}: {
  /** The device to edit, or null to add. */
  device: Device | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [several, setSeveral] = useState(false);
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.get<{ agents: Agent[] }>("/api/agents"),
  });
  const groups = useQuery({
    queryKey: ["groups"],
    queryFn: () => api.get<{ groups: Group[] }>("/api/groups"),
  });
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: () => api.get<{ devices: Device[] }>("/api/devices"),
  });

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);

  const ready = agents.data && groups.data && devices.data;
  const active = (agents.data?.agents ?? []).filter((a) => !a.revoked_at);
  const title = device ? `Edit ${device.name}` : "Add devices";

  return (
    <dialog ref={ref} className="sheet" aria-label={title} onClose={onClose}>
      <header className="sheet-head">
        <h2>{title}</h2>
        {!device && (
          <div className="seg" role="group" aria-label="How many">
            <button type="button" aria-pressed={!several} onClick={() => setSeveral(false)}>
              One device
            </button>
            <button type="button" aria-pressed={several} onClick={() => setSeveral(true)}>
              Several at once
            </button>
          </div>
        )}
      </header>
      {!ready ? (
        <div className="sheet-body muted">Loading…</div>
      ) : several && !device ? (
        <BulkForm
          agents={active}
          groups={groups.data.groups}
          devices={devices.data.devices}
          onClose={() => ref.current?.close()}
        />
      ) : (
        <SingleForm
          device={device}
          agents={active}
          groups={groups.data.groups}
          devices={devices.data.devices}
          onClose={() => ref.current?.close()}
        />
      )}
    </dialog>
  );
}

function useAfterSave() {
  const qc = useQueryClient();
  return () => {
    for (const key of ["devices", "overview", "groups", "device"]) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };
}

/** Turn the group choice into an id, creating the group first if it is a new name. */
async function resolveGroup(c: Checks, groups: Group[]): Promise<number | null> {
  if (c.group !== "new") return c.group;
  const name = c.newGroup.trim();
  const same = groups.find((g) => g.name.trim().toLowerCase() === name.toLowerCase());
  if (same) return same.id;
  return (await api.post<Group>("/api/groups", { name })).id;
}

function ChecksFields({
  c,
  setC,
  agents,
  groups,
}: {
  c: Checks;
  setC: (next: Checks) => void;
  agents: Agent[];
  groups: Group[];
}) {
  const intervals = INTERVALS.filter((i) => c.source === "agent" || i >= 60);
  return (
    <>
      <div className="field-pair">
        <label className="field">
          Group
          <select
            id="device-group"
            value={c.group ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              setC({ ...c, group: v === "new" ? "new" : v === "" ? null : Number(v) });
            }}
          >
            <option value="">Ungrouped</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
            <option value="new">New group…</option>
          </select>
        </label>
        {c.group === "new" && (
          <label className="field">
            New group name
            <input
              id="device-new-group"
              type="text"
              value={c.newGroup}
              onChange={(e) => setC({ ...c, newGroup: e.target.value })}
              required
              maxLength={100}
              autoFocus
            />
          </label>
        )}
      </div>

      <fieldset className="plain col">
        <legend className="field">Pinged by</legend>
        <label className={`radio-card ${c.source === "agent" ? "selected" : ""}`}>
          <input
            type="radio"
            name="source"
            checked={c.source === "agent"}
            disabled={agents.length === 0}
            onChange={() =>
              setC({
                ...c,
                source: "agent",
                agent_id: c.agent_id ?? agents[0]?.id ?? null,
                interval_s: c.interval_s >= 60 ? 30 : c.interval_s,
              })
            }
          />
          <span>
            <strong>A proxy</strong>
            <br />
            <span className="small muted">
              {agents.length === 0 ? (
                <>
                  No proxies yet. Add one on the <Link to="/proxies">Proxies</Link> page.
                </>
              ) : (
                "For devices on the office network. ICMP, as often as every 10s."
              )}
            </span>
          </span>
        </label>
        <label className={`radio-card ${c.source === "web" ? "selected" : ""}`}>
          <input
            type="radio"
            name="source"
            checked={c.source === "web"}
            onChange={() =>
              setC({ ...c, source: "web", interval_s: c.interval_s < 60 ? 60 : c.interval_s })
            }
          />
          <span>
            <strong>The website</strong>
            <br />
            <span className="small muted">
              For devices reachable from the internet. Every 1 min or slower.
            </span>
          </span>
        </label>
      </fieldset>

      <div className="field-pair">
        {c.source === "agent" && (
          <label className="field">
            Proxy
            <select
              id="device-proxy"
              value={c.agent_id ?? ""}
              onChange={(e) => setC({ ...c, agent_id: Number(e.target.value) })}
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
        <label className="field">
          Check every
          <select
            id="device-interval"
            value={c.interval_s}
            onChange={(e) => setC({ ...c, interval_s: Number(e.target.value) })}
          >
            {intervals.map((i) => (
              <option key={i} value={i}>
                {fmtDuration(i)}
              </option>
            ))}
          </select>
        </label>
        {c.source === "web" && (
          <label className="field">
            TCP port if ping is blocked
            <input
              id="device-port"
              type="number"
              min={1}
              max={65535}
              placeholder="443"
              value={c.tcp_fallback_port ?? ""}
              onChange={(e) =>
                setC({ ...c, tcp_fallback_port: e.target.value ? Number(e.target.value) : null })
              }
            />
          </label>
        )}
      </div>
    </>
  );
}

function checksBody(c: Checks, groupId: number | null) {
  return {
    group_id: groupId,
    source: c.source,
    agent_id: c.source === "agent" ? c.agent_id : null,
    interval_s: c.interval_s,
    tcp_fallback_port: c.source === "web" ? c.tcp_fallback_port : null,
  };
}

function SingleForm({
  device,
  agents,
  groups,
  devices,
  onClose,
}: {
  device: Device | null;
  agents: Agent[];
  groups: Group[];
  devices: Device[];
  onClose: () => void;
}) {
  const afterSave = useAfterSave();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(device?.name ?? "");
  const [host, setHost] = useState(device?.host ?? "");
  const [notes, setNotes] = useState(device?.notes ?? "");
  const [enabled, setEnabled] = useState(device?.enabled ?? true);
  const [c, setC] = useState<Checks>(
    device
      ? {
          group: device.group_id,
          newGroup: "",
          source: device.source,
          agent_id: device.agent_id,
          interval_s: device.interval_s,
          tcp_fallback_port: device.tcp_fallback_port,
        }
      : defaultChecks(agents),
  );
  const [hostTouched, setHostTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  const problem = hostProblem(host);
  const twin = devices.find(
    (d) => d.id !== device?.id && d.host.toLowerCase() === host.trim().toLowerCase(),
  );

  const save = useMutation({
    mutationFn: async () => {
      const groupId = await resolveGroup(c, groups);
      // Remember the new group so a retry after an error does not create it twice.
      if (c.group === "new") setC({ ...c, group: groupId, newGroup: "" });
      const body = {
        name: name.trim(),
        host: host.trim(),
        notes: notes.trim() === "" ? null : notes,
        enabled,
        ...checksBody(c, groupId),
      };
      return device ? api.patch(`/api/devices/${device.id}`, body) : api.post("/api/devices", body);
    },
    onSuccess: () => {
      setError(null);
      afterSave();
      if (device) {
        onClose();
        return;
      }
      // Ready for the next one: keep how it is checked, clear what identifies it.
      setAdded(name.trim());
      setName("");
      setHost("");
      setNotes("");
      setHostTouched(false);
      nameRef.current?.focus();
    },
    onError: (e) => {
      setAdded(null);
      setError(errorMessage(e));
      afterSave(); // a new group may have been created before the device failed
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setHostTouched(true);
    if (problem) return;
    save.mutate();
  }

  return (
    <form className="sheet-form" onSubmit={submit}>
      <div className="sheet-body stack">
        {added && (
          <div className="banner ok" role="status">
            Added “{added}”. Add another, or choose Done.
          </div>
        )}
        <div className="field-pair">
          <label className="field">
            Name
            <input
              id="device-name"
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
              autoFocus
            />
          </label>
          <label className="field">
            Hostname or IP address
            <input
              id="device-host"
              type="text"
              className="mono"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              onBlur={() => setHostTouched(host !== "")}
              aria-invalid={hostTouched && problem !== null}
              aria-describedby="device-host-note"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </label>
        </div>
        <div id="device-host-note" className="field-note" aria-live="polite">
          {hostTouched && problem ? (
            <span className="error">{problem}</span>
          ) : twin ? (
            <span>
              “{twin.name}” already uses this address. You can still save a second device for it.
            </span>
          ) : null}
        </div>

        <ChecksFields c={c} setC={setC} agents={agents} groups={groups} />

        <label className="field">
          Notes
          <textarea
            id="device-notes"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={2000}
            placeholder="Where it is, who looks after it, anything odd about it"
          />
        </label>
        {device && (
          <label className="check">
            <input
              id="device-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <span>
              <strong>Checks are on</strong>
              <br />
              <span className="small muted">
                Turn off to stop checking this device. Its history is kept.
              </span>
            </span>
          </label>
        )}
        {error && (
          <div className="error" role="alert">
            Not saved: {error}
          </div>
        )}
      </div>
      <footer className="sheet-foot">
        <button type="button" className="btn" onClick={onClose}>
          {device ? "Cancel" : "Done"}
        </button>
        <button className="btn primary" type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : device ? "Save changes" : "Add device"}
        </button>
      </footer>
    </form>
  );
}

function BulkForm({
  agents,
  groups,
  devices,
  onClose,
}: {
  agents: Agent[];
  groups: Group[];
  devices: Device[];
  onClose: () => void;
}) {
  const afterSave = useAfterSave();
  const [text, setText] = useState("");
  const [c, setC] = useState<Checks>(defaultChecks(agents));
  const [result, setResult] = useState<{ added: number; failed: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const taken = useMemo(
    () => new Map(devices.map((d) => [d.host.toLowerCase(), d.name])),
    [devices],
  );
  const lines = useMemo(() => parseBulk(text, taken), [text, taken]);
  const good = lines.filter((l) => l.problem === null);
  const bad = lines.filter((l) => l.problem !== null);

  const save = useMutation({
    mutationFn: async () => {
      const groupId = await resolveGroup(c, groups);
      if (c.group === "new") setC({ ...c, group: groupId, newGroup: "" });
      const failed: { text: string; why: string }[] = [];
      let added = 0;
      // One at a time, so the devices keep the order they were pasted in.
      for (const l of good) {
        try {
          await api.post("/api/devices", {
            name: l.name,
            host: l.host,
            notes: null,
            enabled: true,
            ...checksBody(c, groupId),
          });
          added++;
        } catch (e) {
          failed.push({ text: l.text, why: `${l.host}: ${errorMessage(e)}` });
        }
      }
      return { added, failed };
    },
    onSuccess: ({ added, failed }) => {
      setError(null);
      setResult({ added, failed: failed.map((f) => f.why) });
      // Leave only the lines that still need attention.
      setText([...bad.map((l) => l.text), ...failed.map((f) => f.text)].join("\n"));
      afterSave();
    },
    onError: (e) => {
      setError(errorMessage(e));
      afterSave();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (good.length === 0) return;
    setResult(null);
    save.mutate();
  }

  return (
    <form className="sheet-form" onSubmit={submit}>
      <div className="sheet-body stack">
        {result && (
          <div className={`banner ${result.failed.length ? "warn" : "ok"}`} role="status">
            <div>
              Added {result.added} device{result.added === 1 ? "" : "s"}.
              {result.failed.length > 0 && (
                <>
                  {" "}
                  {result.failed.length} could not be added and{" "}
                  {result.failed.length === 1 ? "is" : "are"} still in the box:
                  <ul className="problems">
                    {result.failed.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        )}
        <label className="field">
          One device per line, as: name, address
          <textarea
            id="device-bulk"
            className="mono"
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"Core switch, 10.0.0.2\nFirewall, 10.0.0.1\nprinter-2.office.example.com"}
            aria-describedby="device-bulk-note"
            spellCheck={false}
            autoCapitalize="none"
            autoFocus
          />
        </label>
        <div id="device-bulk-note" className="field-note" aria-live="polite">
          {lines.length === 0 ? (
            "A comma or a tab between name and address both work, so rows pasted from a spreadsheet are fine. A line with only an address uses it as the name."
          ) : (
            <>
              {good.length} ready to add
              {bad.length > 0 && `, ${bad.length} need${bad.length === 1 ? "s" : ""} fixing:`}
              {bad.length > 0 && (
                <ul className="problems">
                  {bad.map((l) => (
                    <li key={l.line}>
                      Line {l.line}: {l.problem}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <ChecksFields c={c} setC={setC} agents={agents} groups={groups} />
        <p className="field-note">
          These settings apply to every device in the list. Change any one of them afterwards with
          Edit.
        </p>
        {error && (
          <div className="error" role="alert">
            Nothing was added: {error}
          </div>
        )}
      </div>
      <footer className="sheet-foot">
        <button type="button" className="btn" onClick={onClose}>
          Done
        </button>
        <button
          className="btn primary"
          type="submit"
          disabled={save.isPending || good.length === 0}
        >
          {save.isPending
            ? "Adding…"
            : good.length === 0
              ? "Add devices"
              : `Add ${good.length} device${good.length === 1 ? "" : "s"}`}
        </button>
      </footer>
    </form>
  );
}

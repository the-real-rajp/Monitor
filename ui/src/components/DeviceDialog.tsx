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

/** The groups that exist, shown as choices, then "No group" and a way to name a new one. */
function GroupPicker({
  c,
  setC,
  groups,
}: {
  c: Checks;
  setC: (next: Checks) => void;
  groups: Group[];
}) {
  return (
    <fieldset className="plain col">
      <legend className="field">Group</legend>
      <div className="chips">
        {groups.map((g) => (
          <button
            key={g.id}
            type="button"
            className="chip"
            aria-pressed={c.group === g.id}
            onClick={() => setC({ ...c, group: g.id })}
          >
            {g.name}
          </button>
        ))}
        <button
          type="button"
          className="chip quiet"
          aria-pressed={c.group === null}
          onClick={() => setC({ ...c, group: null })}
        >
          No group
        </button>
        <button
          type="button"
          className="chip quiet"
          aria-pressed={c.group === "new"}
          onClick={() => setC({ ...c, group: "new" })}
        >
          New group…
        </button>
      </div>
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
    </fieldset>
  );
}

function ChecksFields({
  c,
  setC,
  agents,
  groups,
  groupPicker = true,
}: {
  c: Checks;
  setC: (next: Checks) => void;
  agents: Agent[];
  groups: Group[];
  /** False where each device picks its own group, as in the bulk form. */
  groupPicker?: boolean;
}) {
  const intervals = INTERVALS.filter((i) => c.source === "agent" || i >= 60);
  return (
    <>
      {groupPicker && <GroupPicker c={c} setC={setC} groups={groups} />}

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

interface Row {
  key: number;
  name: string;
  host: string;
  /** A group id, null for no group, or "new" while typing a new group's name. */
  group: number | null | "new";
  newGroup: string;
  /** True once the address box has been left, so typing is not interrupted by errors. */
  touched: boolean;
  /** What the server said when this row was tried, if it failed. */
  failed: string | null;
}

let rowKey = 0;
const emptyRow = (group: Row["group"] = null, newGroup = ""): Row => ({
  key: ++rowKey,
  name: "",
  host: "",
  group,
  newGroup,
  touched: false,
  failed: null,
});
const isBlank = (r: Row) => r.name.trim() === "" && r.host.trim() === "";

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
  const [rows, setRows] = useState<Row[]>(() => [emptyRow(), emptyRow(), emptyRow(), emptyRow()]);
  const [c, setC] = useState<Checks>(defaultChecks(agents));
  const [added, setAdded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const patch = (key: number, change: Partial<Row>) =>
    setRows((cur) => cur.map((r) => (r.key === key ? { ...r, failed: null, ...change } : r)));

  // What is wrong with each filled-in row, by key. Blank rows are ignored.
  const problems = useMemo(() => {
    const taken = new Map(devices.map((d) => [d.host.toLowerCase(), d.name]));
    const seen = new Set<string>();
    const out = new Map<number, string>();
    for (const r of rows) {
      if (isBlank(r)) continue;
      const host = r.host.trim();
      const key = host.toLowerCase();
      let problem = hostProblem(host);
      if (!problem && r.name.trim().length > 100)
        problem = "The name is longer than 100 characters.";
      if (!problem && taken.has(key)) problem = `Already monitored as “${taken.get(key)}”.`;
      if (!problem && seen.has(key)) problem = "This address is on an earlier row too.";
      if (!problem && r.group === "new" && r.newGroup.trim() === "") {
        problem = "Name the new group, or pick an existing one.";
      }
      if (!problem) seen.add(key);
      if (problem) out.set(r.key, problem);
    }
    return out;
  }, [rows, devices]);

  const filled = rows.filter((r) => !isBlank(r));
  const good = filled.filter((r) => !problems.has(r.key));

  /** Rows pasted from a spreadsheet or a text list fill this row and the ones after it. */
  function paste(at: number, text: string): boolean {
    if (!/[\t\n]/.test(text.trim())) return false;
    const parsed = parseBulk(text, new Map());
    if (parsed.length === 0) return false;
    setRows((cur) => {
      const here = cur[at]!;
      const fresh = parsed.map((l) => ({
        ...emptyRow(here.group, here.newGroup),
        name: l.name === l.host ? "" : l.name,
        host: l.host,
        touched: true,
      }));
      const before = cur.slice(0, at);
      const after = cur.slice(isBlank(here) ? at + 1 : at).filter((r) => !isBlank(r));
      return [...before, ...fresh, ...after, emptyRow(here.group, here.newGroup)];
    });
    return true;
  }

  const save = useMutation({
    mutationFn: async () => {
      // Create each new group once, however many rows name it.
      const ids = new Map(groups.map((g) => [g.name.trim().toLowerCase(), g.id]));
      const failures = new Map<number, string>();
      const done: number[] = [];
      // One at a time, so the devices keep the order they are listed in.
      for (const r of good) {
        try {
          let groupId: number | null;
          if (r.group === "new") {
            const name = r.newGroup.trim();
            if (!ids.has(name.toLowerCase())) {
              ids.set(name.toLowerCase(), (await api.post<Group>("/api/groups", { name })).id);
            }
            groupId = ids.get(name.toLowerCase())!;
          } else {
            groupId = r.group;
          }
          await api.post("/api/devices", {
            name: r.name.trim() || r.host.trim(),
            host: r.host.trim(),
            notes: null,
            enabled: true,
            ...checksBody(c, groupId),
          });
          done.push(r.key);
        } catch (e) {
          failures.set(r.key, errorMessage(e));
        }
      }
      return { done, failures, ids };
    },
    onSuccess: ({ done, failures, ids }) => {
      setError(null);
      setAdded(done.length);
      setRows((cur) => {
        const left = cur
          .filter((r) => !done.includes(r.key) && !isBlank(r))
          .map((r) => {
            // A group created just now is an ordinary group from here on.
            const id = r.group === "new" ? ids.get(r.newGroup.trim().toLowerCase()) : undefined;
            const next = id === undefined ? r : { ...r, group: id, newGroup: "" };
            return { ...next, failed: failures.get(r.key) ?? null };
          });
        return left.length > 0 ? left : [emptyRow(), emptyRow(), emptyRow(), emptyRow()];
      });
      afterSave();
    },
    onError: (e) => {
      setError(errorMessage(e));
      afterSave();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setRows((cur) => cur.map((r) => (isBlank(r) ? r : { ...r, touched: true })));
    if (good.length === 0) return;
    setAdded(null);
    save.mutate();
  }

  const stuck = rows.filter((r) => r.failed !== null).length;
  const last = rows[rows.length - 1];

  return (
    <form className="sheet-form" onSubmit={submit}>
      <div className="sheet-body stack">
        {added !== null && (
          <div className={`banner ${stuck ? "warn" : "ok"}`} role="status">
            Added {added} device{added === 1 ? "" : "s"}.
            {stuck > 0 &&
              ` ${stuck} could not be added and ${stuck === 1 ? "is" : "are"} still listed below.`}
          </div>
        )}
        <div className="rows" role="group" aria-label="Devices to add">
          <div className="rows-head" aria-hidden="true">
            <span>Name</span>
            <span>Hostname or IP address</span>
            <span>Group</span>
            <span />
          </div>
          {rows.map((r, i) => {
            const problem = r.failed ?? (r.touched ? problems.get(r.key) : undefined);
            return (
              <div key={r.key} className="row-edit">
                <input
                  type="text"
                  aria-label={`Name, row ${i + 1}`}
                  value={r.name}
                  placeholder={r.host.trim() || "Name"}
                  maxLength={100}
                  onChange={(e) => patch(r.key, { name: e.target.value })}
                  onPaste={(e) => {
                    if (paste(i, e.clipboardData.getData("text"))) e.preventDefault();
                  }}
                  autoFocus={i === 0}
                />
                <input
                  type="text"
                  className="mono"
                  aria-label={`Hostname or IP address, row ${i + 1}`}
                  aria-invalid={problem !== undefined}
                  value={r.host}
                  placeholder="10.0.0.2"
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(e) => patch(r.key, { host: e.target.value })}
                  onBlur={() => patch(r.key, { touched: r.host !== "", failed: r.failed })}
                  onPaste={(e) => {
                    if (paste(i, e.clipboardData.getData("text"))) e.preventDefault();
                  }}
                />
                {r.group === "new" ? (
                  <input
                    type="text"
                    aria-label={`New group name, row ${i + 1}`}
                    value={r.newGroup}
                    placeholder="New group name"
                    maxLength={100}
                    onChange={(e) => patch(r.key, { newGroup: e.target.value })}
                    autoFocus
                  />
                ) : (
                  <select
                    aria-label={`Group, row ${i + 1}`}
                    value={r.group ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      patch(r.key, { group: v === "new" ? "new" : v === "" ? null : Number(v) });
                    }}
                  >
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                    <option value="">No group</option>
                    <option value="new">New group…</option>
                  </select>
                )}
                <button
                  type="button"
                  className="btn sm row-remove"
                  aria-label={`Remove row ${i + 1}`}
                  title="Remove this row"
                  onClick={() =>
                    setRows((cur) =>
                      cur.length > 1 ? cur.filter((x) => x.key !== r.key) : [emptyRow()],
                    )
                  }
                >
                  ×
                </button>
                {problem && <div className="row-problem error">{problem}</div>}
              </div>
            );
          })}
        </div>
        <div className="row between">
          <button
            type="button"
            className="btn sm"
            onClick={() =>
              setRows((cur) => [...cur, emptyRow(last?.group ?? null, last?.newGroup ?? "")])
            }
          >
            Add a row
          </button>
          <span className="field-note" style={{ margin: 0 }}>
            Rows copied from a spreadsheet can be pasted into any name or address box.
          </span>
        </div>

        <ChecksFields c={c} setC={setC} agents={agents} groups={groups} groupPicker={false} />
        <p className="field-note">
          How they are checked applies to every device listed. Change any one afterwards with Edit.
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
          disabled={save.isPending || filled.length === 0}
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

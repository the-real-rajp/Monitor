import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api, type Day, type Device, type History, type Outage, type Range } from "../api/client";
import DeviceDialog from "../components/DeviceDialog";
import RttChart from "../components/RttChart";
import UptimeStrip from "../components/UptimeStrip";
import { fmtDateTime, fmtDuration, fmtFor, fmtPct, fmtRtt } from "../lib/format";
import { useAuth } from "../lib/auth";
import { useRefresh } from "../lib/refresh";

const RANGES: { key: Range; label: string; title: string }[] = [
  { key: "1h", label: "1h", title: "Last hour" },
  { key: "24h", label: "24h", title: "Last 24 hours" },
  { key: "7d", label: "7d", title: "Last 7 days" },
  { key: "30d", label: "30d", title: "Last 30 days" },
];

export default function DevicePage() {
  const { id } = useParams();
  const { me } = useAuth();
  const { ms, slowMs } = useRefresh();
  const [range, setRange] = useState<Range>("24h");
  const [editing, setEditing] = useState(false);

  const device = useQuery({
    queryKey: ["device", id],
    queryFn: () => api.get<Device>(`/api/devices/${id}`),
    refetchInterval: ms,
  });
  const history = useQuery({
    queryKey: ["history", id, range],
    queryFn: () => api.get<History>(`/api/devices/${id}/history?range=${range}`),
    refetchInterval: range === "1h" ? ms : slowMs,
  });
  const days = useQuery({
    queryKey: ["days", id],
    queryFn: () => api.get<{ timezone: string; days: Day[] }>(`/api/devices/${id}/days?days=30`),
    refetchInterval: slowMs,
  });
  const events = useQuery({
    queryKey: ["events", id],
    queryFn: () => api.get<{ events: Outage[] }>(`/api/devices/${id}/events?days=30`),
    refetchInterval: slowMs,
  });

  if (device.isLoading) return <div className="page-loading">Loading…</div>;
  if (device.isError || !device.data) return <div className="banner danger">Device not found.</div>;
  const d = device.data;
  const s = d.status;
  const h = history.data;
  const rangeTitle = RANGES.find((r) => r.key === range)!.title;
  const method =
    d.source === "web"
      ? s.last_method === "tcp"
        ? `TCP connect to ${d.tcp_fallback_port ?? "?"}`
        : s.last_method === "icmp"
          ? "ICMP"
          : d.tcp_fallback_port
            ? `TCP ${d.tcp_fallback_port} if ICMP is blocked`
            : "ICMP only"
      : "ICMP";

  return (
    <>
      <nav aria-label="Breadcrumb" className="small muted crumbs">
        <Link to="/">Overview</Link> › {d.group_name ?? "Ungrouped"} ›{" "}
        <span style={{ color: "var(--text)" }}>{d.name}</span>
      </nav>

      <section
        className={`status ${s.state === "down" ? "danger" : ""}`}
        aria-label="Current state"
      >
        <div className="row between" style={{ alignItems: "flex-start" }}>
          <h1 className="status-line">
            <span className={`dot ${s.state}`} />
            {d.name}{" "}
            {s.state === "up" ? "is up" : s.state === "down" ? "is down" : "has no recent data"}
            {!d.enabled && <span className="pill">disabled</span>}
          </h1>
          {me?.user.role === "admin" && (
            <button className="btn" onClick={() => setEditing(true)}>
              Edit device
            </button>
          )}
        </div>
        <dl className="facts">
          {s.state !== "unknown" && (
            <div>
              <dt>{s.state === "up" ? "Up for" : "Down for"}</dt>
              <dd className={s.state === "down" ? "danger-ink" : undefined}>{fmtFor(s.since)}</dd>
            </div>
          )}
          <div>
            <dt>Address</dt>
            <dd className="mono">{d.host}</dd>
          </div>
          <div>
            <dt>Pinged by</dt>
            <dd>
              {d.source === "web" ? "The website" : (d.agent_name ?? "A proxy")}
              <span className="aside">every {fmtDuration(d.interval_s)}</span>
            </dd>
          </div>
          <div>
            <dt>Method</dt>
            <dd>{method}</dd>
          </div>
        </dl>
        {d.notes && (
          <p className="muted" style={{ margin: 0, maxWidth: 720 }}>
            {d.notes}
          </p>
        )}
      </section>

      <section className="card col" aria-label="Last 30 days">
        <div className="row between">
          <h2>Last 30 days</h2>
          {days.data && <span className="small muted">day boundaries in {days.data.timezone}</span>}
        </div>
        {days.data ? (
          <UptimeStrip days={days.data.days} />
        ) : (
          <div className="muted small">Loading…</div>
        )}
      </section>

      <section className="card col" aria-label="Response time">
        <div className="row between">
          <h2>Response time, {rangeTitle.toLowerCase()}</h2>
          <div className="seg" role="group" aria-label="Range">
            {RANGES.map((r) => (
              <button
                key={r.key}
                aria-pressed={range === r.key}
                onClick={() => setRange(r.key)}
                title={r.title}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <dl className="facts" aria-label={`Summary, ${rangeTitle.toLowerCase()}`}>
          <div>
            <dt>Uptime</dt>
            <dd>{fmtPct(h?.summary.uptime)}</dd>
          </div>
          <div>
            <dt>Average response</dt>
            <dd>
              {fmtRtt(h?.summary.avg_rtt_ms)}
              {h?.summary.avg_rtt_ms != null && " ms"}
            </dd>
          </div>
          <div>
            <dt>Outages</dt>
            <dd>
              {h?.summary.outages ?? "—"}
              {h?.summary.longest_outage_s != null && (
                <span className="aside">longest {fmtDuration(h.summary.longest_outage_s)}</span>
              )}
            </dd>
          </div>
        </dl>
        {h ? <RttChart history={h} /> : <div className="muted small">Loading…</div>}
        <div className="legend">
          <span>
            <i className="swatch" style={{ background: "var(--accent)", height: 2 }} />{" "}
            {h?.resolution === "raw"
              ? "each ping"
              : h?.resolution === "minute"
                ? "per-minute average"
                : "hourly average"}
          </span>
          {h && h.resolution !== "raw" && (
            <span>
              <i className="swatch" style={{ background: "var(--accent)", opacity: 0.2 }} /> min to
              max
            </span>
          )}
          <span>
            <i className="swatch" style={{ background: "var(--danger)", width: 3 }} /> timeout
          </span>
        </div>
      </section>

      <section className="table-card" aria-label="Outages">
        <div className="head">
          <h2>Outages in the last 30 days</h2>
          {events.data && (
            <span className="small muted">
              {events.data.events.length} outage{events.data.events.length === 1 ? "" : "s"} ·{" "}
              {fmtDuration(events.data.events.reduce((a, e) => a + (e.duration_s ?? 0), 0))} total
            </span>
          )}
        </div>
        {events.data && events.data.events.length === 0 ? (
          <div className="empty" style={{ padding: "2rem" }}>
            No outages recorded.
          </div>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th className="hide-sm">Ended</th>
                  <th>Duration</th>
                  <th className="hide-sm">Detected by</th>
                </tr>
              </thead>
              <tbody>
                {events.data?.events.map((e) => (
                  <tr key={e.id}>
                    <td className="mono small">{fmtDateTime(e.started_at)}</td>
                    <td className="mono small hide-sm">
                      {e.ongoing ? (
                        <span className="danger-ink">ongoing</span>
                      ) : (
                        fmtDateTime(e.ended_at)
                      )}
                    </td>
                    <td style={{ fontWeight: 600 }}>
                      {e.ongoing ? fmtFor(e.started_at) : fmtDuration(e.duration_s)}
                      {e.ongoing && <span className="danger-ink only-sm"> · ongoing</span>}
                    </td>
                    <td className="muted hide-sm">{e.detected_by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {editing && <DeviceDialog device={d} onClose={() => setEditing(false)} />}
    </>
  );
}

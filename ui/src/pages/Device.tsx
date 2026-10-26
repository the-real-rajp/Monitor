import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api, type Day, type Device, type History, type Outage, type Range } from "../api/client";
import RttChart from "../components/RttChart";
import UptimeStrip from "../components/UptimeStrip";
import { fmtDateTime, fmtDuration, fmtFor, fmtPct, fmtRtt } from "../lib/format";
import { useAuth } from "../lib/auth";

const RANGES: { key: Range; label: string; title: string }[] = [
  { key: "1h", label: "1h", title: "Last hour" },
  { key: "24h", label: "24h", title: "Last 24 hours" },
  { key: "7d", label: "7d", title: "Last 7 days" },
  { key: "30d", label: "30d", title: "Last 30 days" },
];

export default function DevicePage() {
  const { id } = useParams();
  const { me } = useAuth();
  const [range, setRange] = useState<Range>("24h");

  const device = useQuery({
    queryKey: ["device", id],
    queryFn: () => api.get<Device>(`/api/devices/${id}`),
    refetchInterval: 15_000,
  });
  const history = useQuery({
    queryKey: ["history", id, range],
    queryFn: () => api.get<History>(`/api/devices/${id}/history?range=${range}`),
    refetchInterval: range === "1h" ? 15_000 : 60_000,
  });
  const days = useQuery({
    queryKey: ["days", id],
    queryFn: () => api.get<{ timezone: string; days: Day[] }>(`/api/devices/${id}/days?days=30`),
    refetchInterval: 60_000,
  });
  const events = useQuery({
    queryKey: ["events", id],
    queryFn: () => api.get<{ events: Outage[] }>(`/api/devices/${id}/events?days=30`),
    refetchInterval: 60_000,
  });

  if (device.isLoading) return <div className="page-loading">Loading…</div>;
  if (device.isError || !device.data) return <div className="banner danger">Device not found.</div>;
  const d = device.data;
  const s = d.status;
  const h = history.data;
  const rangeTitle = RANGES.find((r) => r.key === range)!.title;
  const by =
    d.source === "web"
      ? `Pinged from the website every ${fmtDuration(d.interval_s)}`
      : `Pinged by ${d.agent_name ?? "a proxy"} every ${fmtDuration(d.interval_s)}`;
  const method =
    d.source === "web"
      ? s.last_method === "tcp"
        ? `method: TCP connect to ${d.tcp_fallback_port ?? "?"}`
        : s.last_method === "icmp"
          ? "method: ICMP"
          : d.tcp_fallback_port
            ? `TCP ${d.tcp_fallback_port} if ICMP is blocked`
            : "ICMP only"
      : "ICMP";

  return (
    <>
      <nav aria-label="Breadcrumb" className="small muted">
        <Link to="/">Overview</Link> › {d.group_name ?? "Ungrouped"} ›{" "}
        <span style={{ color: "var(--text)" }}>{d.name}</span>
      </nav>

      <section className="row between" style={{ alignItems: "flex-start" }}>
        <div className="col" style={{ gap: 6 }}>
          <h1 className="row" style={{ gap: 12, fontSize: 26 }}>
            <span
              className={`dot ${s.state}`}
              style={{ width: 12, height: 12 }}
              role="img"
              aria-label={s.state}
            />
            {d.name}
            {!d.enabled && <span className="pill">disabled</span>}
          </h1>
          <div className="row small muted" style={{ gap: "8px 16px" }}>
            <span className="mono">{d.host}</span>
            <span>{by}</span>
            <span className="pill soft">{method}</span>
            {s.state === "up" && (
              <span className="ok-ink" style={{ fontWeight: 600 }}>
                up for {fmtFor(s.since)}
              </span>
            )}
            {s.state === "down" && (
              <span className="danger-ink" style={{ fontWeight: 600 }}>
                down for {fmtFor(s.since)}
              </span>
            )}
            {s.state === "unknown" && <span>no recent data</span>}
          </div>
          {d.notes && (
            <p className="muted" style={{ margin: "4px 0 0", maxWidth: 720 }}>
              {d.notes}
            </p>
          )}
        </div>
        {me?.user.role === "admin" && (
          <Link to={`/devices?edit=${d.id}`} className="btn">
            Edit device
          </Link>
        )}
      </section>

      <section className="stat-grid" aria-label={`Summary, ${rangeTitle}`}>
        <div className="stat">
          <div className="label">Uptime · {rangeTitle}</div>
          <div className="value">{fmtPct(h?.summary.uptime)}</div>
        </div>
        <div className="stat">
          <div className="label">Average RTT</div>
          <div className="value">
            {fmtRtt(h?.summary.avg_rtt_ms)}
            {h?.summary.avg_rtt_ms != null && <span className="unit">ms</span>}
          </div>
        </div>
        <div className="stat">
          <div className="label">Outages</div>
          <div className="value">{h?.summary.outages ?? "—"}</div>
        </div>
        <div className="stat">
          <div className="label">Longest outage</div>
          <div className="value">{fmtDuration(h?.summary.longest_outage_s)}</div>
        </div>
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
          <h2>Response time</h2>
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
            <i className="swatch" style={{ background: "var(--danger)", width: 4 }} /> timeout
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
            <table style={{ minWidth: 560 }}>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Ended</th>
                  <th>Duration</th>
                  <th>Detected by</th>
                </tr>
              </thead>
              <tbody>
                {events.data?.events.map((e) => (
                  <tr key={e.id}>
                    <td className="mono small">{fmtDateTime(e.started_at)}</td>
                    <td className="mono small">
                      {e.ongoing ? (
                        <span className="danger-ink">ongoing</span>
                      ) : (
                        fmtDateTime(e.ended_at)
                      )}
                    </td>
                    <td style={{ fontWeight: 600 }}>
                      {e.ongoing ? fmtFor(e.started_at) : fmtDuration(e.duration_s)}
                    </td>
                    <td className="muted">{e.detected_by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

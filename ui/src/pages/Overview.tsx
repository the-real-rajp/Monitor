import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type Overview as OverviewData, type OverviewDevice } from "../api/client";
import Sparkline from "../components/Sparkline";
import { fmtAgo, fmtDuration, fmtFor, fmtPct, fmtRtt } from "../lib/format";
import { useAuth } from "../lib/auth";

export default function Overview() {
  const { me } = useAuth();
  const q = useQuery({
    queryKey: ["overview"],
    queryFn: () => api.get<OverviewData>("/api/overview"),
    refetchInterval: 10_000,
  });
  if (q.isLoading) return <div className="page-loading">Loading…</div>;
  if (q.isError || !q.data)
    return <div className="banner danger">Could not load the overview.</div>;
  const o = q.data;
  const all = o.groups.flatMap((g) => g.devices);
  const down = all.filter((d) => d.state === "down");
  const offlineAgents = o.agents.filter((a) => !a.online);
  const hasWeb = all.some((d) => d.source === "web");

  return (
    <>
      <section className="stat-grid" aria-label="Summary">
        <div className="stat">
          <div className="label">Devices</div>
          <div className="value">{o.summary.devices}</div>
          <div className="sub">
            {all.filter((d) => d.source === "agent").length} on proxies ·{" "}
            {all.filter((d) => d.source === "web").length} from the website
          </div>
        </div>
        <div className="stat">
          <div className="label">Up right now</div>
          <div className="value ok-ink">{o.summary.up}</div>
          <div className="sub">
            {o.summary.down > 0 ? (
              <span className="danger-ink" style={{ fontWeight: 600 }}>
                {o.summary.down} down
              </span>
            ) : (
              "nothing down"
            )}
            {o.summary.unknown > 0 && ` · ${o.summary.unknown} unknown`}
          </div>
        </div>
        <div className="stat">
          <div className="label">30-day uptime</div>
          <div className="value">{fmtPct(o.summary.uptime_30d)}</div>
          <div className="sub">
            {o.summary.outages_30d} outage{o.summary.outages_30d === 1 ? "" : "s"}
            {o.summary.longest_outage_30d_s !== null &&
              `, longest ${fmtDuration(o.summary.longest_outage_30d_s)}`}
          </div>
        </div>
        <div className="stat">
          <div className="label">Last checks</div>
          <div className="value" style={{ fontSize: 22 }}>
            {o.agents[0]
              ? fmtAgo(o.agents[0].last_seen_at)
              : hasWeb
                ? fmtAgo(o.web_pinger.last_run_at)
                : "—"}
          </div>
          <div className="sub">
            {o.agents.map((a) => `${a.name} ${fmtAgo(a.last_seen_at)}`).join(" · ")}
            {hasWeb &&
              `${o.agents.length ? " · " : ""}website cron ${fmtAgo(o.web_pinger.last_run_at)}`}
          </div>
        </div>
      </section>

      {offlineAgents.map((a) => (
        <div key={a.id} className="banner danger" role="status">
          <span className="dot down" />
          <div>
            <strong>Proxy “{a.name}” is offline.</strong> Last heartbeat {fmtAgo(a.last_seen_at)}.
            Its {a.device_count} device{a.device_count === 1 ? "" : "s"} show as unknown, not down.
          </div>
        </div>
      ))}
      {o.web_pinger.last_error && (
        <div className="banner warn" role="status">
          The website's last check run failed: {o.web_pinger.last_error}
        </div>
      )}

      {all.length === 0 && (
        <div className="card empty">
          <h2>No devices yet</h2>
          <p>
            {me?.user.role === "admin" ? (
              <>
                Add a <Link to="/proxies">proxy</Link> for your office network, then{" "}
                <Link to="/devices">devices</Link> to ping.
              </>
            ) : (
              "An admin has not added any devices yet."
            )}
          </p>
        </div>
      )}

      {down.length > 0 && (
        <section className="col">
          <h2 className="section-title danger">
            <span className="dot down" /> Down
          </h2>
          <div className="tiles">
            {down.map((d) => (
              <Tile key={d.id} d={d} />
            ))}
          </div>
        </section>
      )}

      {o.groups.map((g) => (
        <section key={g.id ?? "none"} className="col">
          <h2 className="section-title">
            {g.name}
            <span className="note">{groupNote(g.devices)}</span>
          </h2>
          <div className="tiles">
            {g.devices.map((d) => (
              <Tile key={d.id} d={d} />
            ))}
          </div>
        </section>
      ))}

      <p className="small faint" style={{ margin: 0 }}>
        Refreshes every 10 seconds · raw results kept 7 days, hourly history 13 months
      </p>
    </>
  );
}

function groupNote(devices: OverviewDevice[]): string {
  const srcs = new Set(
    devices.map((d) => (d.source === "web" ? "website" : (d.agent_name ?? "proxy"))),
  );
  const ints = new Set(devices.map((d) => d.interval_s));
  const every = ints.size === 1 ? ` · every ${fmtDuration([...ints][0]!)}` : "";
  return [...srcs].join(", ") + every;
}

function Tile({ d }: { d: OverviewDevice }) {
  const badge =
    d.state === "down"
      ? `down ${fmtFor(d.since)}`
      : d.state === "unknown"
        ? "no data"
        : d.last_method === "tcp"
          ? "tcp"
          : "icmp";
  return (
    <Link to={`/devices/${d.id}`} className={`tile ${d.state}`}>
      <div className="head">
        <div style={{ minWidth: 0 }}>
          <div className="name">
            <span className={`dot ${d.state}`} />
            {d.name}
          </div>
          <div className="host">{d.host}</div>
        </div>
        <span className={`pill soft ${d.state === "down" ? "danger" : ""}`}>{badge}</span>
      </div>
      <div className="foot">
        <div>
          <div className={`rtt ${d.state === "down" ? "down" : ""}`}>
            {d.state === "down" ? (
              "timeout"
            ) : (
              <>
                {fmtRtt(d.last_rtt_ms)}
                {d.last_rtt_ms !== null && <span className="unit">ms</span>}
              </>
            )}
          </div>
          <div className="sub">24h uptime {fmtPct(d.uptime_24h)}</div>
        </div>
        <Sparkline points={d.spark} />
      </div>
    </Link>
  );
}

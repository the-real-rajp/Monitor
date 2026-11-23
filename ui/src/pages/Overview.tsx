import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type Overview as OverviewData, type OverviewDevice } from "../api/client";
import { dayClass, fmtAgo, fmtDay, fmtDuration, fmtFor, fmtPct, fmtRtt } from "../lib/format";
import { useAuth } from "../lib/auth";
import { refreshLabel, useRefresh } from "../lib/refresh";

export default function Overview() {
  const { me } = useAuth();
  const { ms, choice, siteDefault } = useRefresh();
  const refreshS = choice === "default" ? siteDefault : choice;
  const q = useQuery({
    queryKey: ["overview"],
    queryFn: () => api.get<OverviewData>("/api/overview"),
    refetchInterval: ms,
  });
  if (q.isLoading) return <div className="page-loading">Loading…</div>;
  if (q.isError || !q.data)
    return <div className="banner danger">Could not load the overview.</div>;
  const o = q.data;
  const all = o.groups.flatMap((g) => g.devices);
  const down = all.filter((d) => d.state === "down");
  const offlineAgents = o.agents.filter((a) => !a.online);
  const hasWeb = all.some((d) => d.source === "web");
  const { devices: total, unknown } = o.summary;
  const headline =
    total === 0
      ? { tone: "", dot: "", text: "Nothing is being monitored yet" }
      : down.length > 0
        ? {
            tone: "danger",
            dot: "down",
            text:
              down.length === 1
                ? `${down[0]!.name} is down`
                : `${down.length} of ${total} devices are down`,
          }
        : unknown > 0
          ? {
              tone: "",
              dot: "unknown",
              text: `Nothing is down, but ${unknown} device${unknown === 1 ? " has" : "s have"} no data`,
            }
          : {
              tone: "ok",
              dot: "up",
              text: total === 1 ? "The one device is up" : `All ${total} devices are up`,
            };
  const checks = [
    ...o.agents.map((a) => ({ name: a.name, at: a.last_seen_at, stale: !a.online })),
    ...(hasWeb
      ? [{ name: "Website", at: o.web_pinger.last_run_at, stale: !!o.web_pinger.last_error }]
      : []),
  ];

  return (
    <>
      <section className={`status ${headline.tone}`} aria-label="Summary">
        <h1 className="status-line">
          <span className={`dot ${headline.dot}`} />
          {headline.text}
        </h1>
        <dl className="facts">
          <div>
            <dt>Up</dt>
            <dd>
              {o.summary.up} of {o.summary.devices}
            </dd>
          </div>
          {o.summary.unknown > 0 && (
            <div>
              <dt>No data</dt>
              <dd>{o.summary.unknown}</dd>
            </div>
          )}
          <div>
            <dt>30-day uptime</dt>
            <dd>{fmtPct(o.summary.uptime_30d)}</dd>
          </div>
          <div>
            <dt>Outages in 30 days</dt>
            <dd>
              {o.summary.outages_30d}
              {o.summary.longest_outage_30d_s !== null && (
                <span className="aside">longest {fmtDuration(o.summary.longest_outage_30d_s)}</span>
              )}
            </dd>
          </div>
          {checks.map((c) => (
            <div key={c.name}>
              <dt>{c.name} checked</dt>
              <dd className={c.stale ? "danger-ink" : undefined}>{fmtAgo(c.at)}</dd>
            </div>
          ))}
        </dl>
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

      {all.length > 0 && (
        <div className="board">
          <div className="board-cols" aria-hidden="true">
            <span>Device</span>
            <span className="board-axis">
              <span>{o.days[0] ? fmtDay(o.days[0]) : ""}</span>
              <span>Daily uptime, last {o.days.length} days</span>
              <span>Today</span>
            </span>
            <span className="num">{o.days.length} days</span>
            <span className="num">Now</span>
          </div>

          {down.length > 0 && (
            <section className="group down" aria-label="Down">
              <h2 className="group-head">Down</h2>
              {down.map((d) => (
                <Row
                  key={d.id}
                  d={d}
                  dates={o.days}
                  group={o.groups.find((g) => g.devices.includes(d))?.name}
                />
              ))}
            </section>
          )}

          {o.groups.map((g) => {
            // Down devices are already listed under "Down"; each device has one row.
            const rest = g.devices.filter((d) => d.state !== "down");
            const nDown = g.devices.length - rest.length;
            return (
              <section key={g.id ?? "none"} className="group" aria-label={g.name}>
                <h2 className="group-head">
                  {g.name}
                  <span className="note">
                    {groupNote(g.devices)}
                    {nDown > 0 && `, ${nDown} down (listed above)`}
                  </span>
                </h2>
                {rest.map((d) => (
                  <Row key={d.id} d={d} dates={o.days} />
                ))}
              </section>
            );
          })}
        </div>
      )}

      {all.length > 0 && (
        <div className="legend">
          <span>
            <i className="swatch day-ok" /> 99.9% and above
          </span>
          <span>
            <i className="swatch day-warn" /> 99% to 99.9%
          </span>
          <span>
            <i className="swatch day-bad" /> below 99%
          </span>
          <span>
            <i className="swatch day-none" /> no data
          </span>
          <span>Days start at midnight, {o.timezone}</span>
        </div>
      )}

      <p className="small faint" style={{ margin: 0 }}>
        {refreshS > 0 ? `Refreshes every ${refreshLabel(refreshS)}` : "Auto-refresh is off"}
        {o.retention &&
          ` · individual pings kept ${fmtDays(o.retention.raw_days)}, hourly history ${fmtDays(o.retention.hourly_days)}`}
      </p>
    </>
  );
}

function fmtDays(days: number): string {
  if (days >= 60) return `${Math.round(days / 30.44)} months`;
  return `${days} day${days === 1 ? "" : "s"}`;
}

function groupNote(devices: OverviewDevice[]): string {
  const srcs = new Set(
    devices.map((d) => (d.source === "web" ? "the website" : (d.agent_name ?? "a proxy"))),
  );
  const ints = new Set(devices.map((d) => d.interval_s));
  const every = ints.size === 1 ? `, every ${fmtDuration([...ints][0]!)}` : "";
  return "Pinged by " + [...srcs].join(" and ") + every;
}

function stripSummary(days: (number | null)[]): string {
  const n = (cls: string) => days.filter((p) => dayClass(p) === cls).length;
  const parts = [
    [n("day-ok"), "at 99.9% or above"],
    [n("day-warn"), "between 99% and 99.9%"],
    [n("day-bad"), "below 99%"],
    [n("day-none"), "with no data"],
  ] as const;
  return (
    `Last ${days.length} days: ` +
    parts
      .filter(([count]) => count > 0)
      .map(([count, what]) => `${count} ${what}`)
      .join(", ")
  );
}

/** One device: who it is, its last 30 days as a strip, and how it is doing right now. */
function Row({ d, dates, group }: { d: OverviewDevice; dates: string[]; group?: string }) {
  return (
    <Link to={`/devices/${d.id}`} className={`dev ${d.state}`}>
      <div className="dev-who">
        <div className="dev-name">
          <span className={`dot ${d.state}`} role="img" aria-label={d.state} />
          {d.name}
        </div>
        <div className="dev-host">
          {d.host}
          {group && <span className="dev-group">{group}</span>}
        </div>
      </div>
      <div className="dev-strip" role="img" aria-label={stripSummary(d.days)}>
        {d.days.map((p, i) => (
          <i
            key={i}
            className={dayClass(p)}
            title={`${dates[i] ? fmtDay(dates[i]) : ""}: ${p === null ? "no data" : fmtPct(p)}`}
          />
        ))}
      </div>
      <div className="dev-pct num">{fmtPct(d.uptime_30d)}</div>
      <div className="dev-now num">
        {d.state === "down" ? (
          <span className="danger-ink">down {fmtFor(d.since)}</span>
        ) : d.state === "unknown" ? (
          <span className="muted">no data</span>
        ) : (
          <>
            {fmtRtt(d.last_rtt_ms)}
            {d.last_rtt_ms !== null && <span className="unit">ms</span>}
            {d.last_method === "tcp" && <span className="unit">TCP</span>}
          </>
        )}
      </div>
    </Link>
  );
}

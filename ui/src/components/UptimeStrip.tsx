import type { Day } from "../api/client";
import { fmtDay, fmtDuration, fmtPct, uptimeColor } from "../lib/format";

/** One bar per day, coloured by availability. */
export default function UptimeStrip({ days }: { days: Day[] }) {
  return (
    <div className="col" style={{ gap: 10 }}>
      <div
        className="strip"
        role="img"
        aria-label={`Daily uptime for the last ${days.length} days`}
      >
        {days.map((d) => (
          <div
            key={d.date}
            className="cell"
            style={{ background: uptimeColor(d.uptime) }}
            title={
              d.uptime === null
                ? `${fmtDay(d.date)}: no data`
                : `${fmtDay(d.date)}: ${fmtPct(d.uptime)} uptime` +
                  (d.outages
                    ? `, ${d.outages} outage${d.outages > 1 ? "s" : ""} (${fmtDuration(d.down_s)})`
                    : "")
            }
          />
        ))}
      </div>
      <div className="row between small faint">
        <span>{days[0] ? fmtDay(days[0].date) : ""}</span>
        <span>
          {days[Math.floor(days.length / 2)] ? fmtDay(days[Math.floor(days.length / 2)]!.date) : ""}
        </span>
        <span>Today</span>
      </div>
      <div className="legend">
        <span>
          <i className="swatch" style={{ background: "var(--ok)" }} /> 99.9% and above
        </span>
        <span>
          <i className="swatch" style={{ background: "var(--warn)" }} /> 99% to 99.9%
        </span>
        <span>
          <i className="swatch" style={{ background: "var(--danger)" }} /> below 99%
        </span>
        <span>
          <i className="swatch" style={{ background: "var(--nodata)" }} /> no data
        </span>
      </div>
    </div>
  );
}

import { useState } from "react";
import type { Day } from "../api/client";
import { dayClass, fmtDay, fmtDuration, fmtPct } from "../lib/format";

function describe(d: Day): string {
  if (d.uptime === null) return `${fmtDay(d.date)}: no data`;
  return (
    `${fmtDay(d.date)}: ${fmtPct(d.uptime)} uptime` +
    (d.outages ? `, ${d.outages} outage${d.outages > 1 ? "s" : ""} (${fmtDuration(d.down_s)})` : "")
  );
}

/** One bar per day, coloured by availability. Point at, tab to or tap a day for its figures. */
export default function UptimeStrip({ days }: { days: Day[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [pointed, setPointed] = useState<string | null>(null);
  const shown = days.find((d) => d.date === (pointed ?? picked));

  return (
    <div className="col" style={{ gap: 10 }}>
      <div
        className="strip"
        role="group"
        aria-label={`Daily uptime for the last ${days.length} days`}
        onMouseLeave={() => setPointed(null)}
      >
        {days.map((d) => (
          <button
            key={d.date}
            type="button"
            className={`cell ${dayClass(d.uptime)}`}
            aria-label={describe(d)}
            aria-pressed={picked === d.date}
            onClick={() => setPicked(picked === d.date ? null : d.date)}
            onMouseEnter={() => setPointed(d.date)}
            onFocus={() => setPointed(d.date)}
            onBlur={() => setPointed(null)}
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
      <div className="strip-readout" aria-live="polite">
        {shown ? describe(shown) : <span className="faint">Select a day to see its figures.</span>}
      </div>
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
      </div>
    </div>
  );
}

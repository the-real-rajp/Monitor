import { useEffect, useRef } from "react";
import uPlot from "uplot";
import type { AggPoint, History, RawPoint } from "../api/client";

/**
 * Response-time chart on uPlot. Raw ranges draw each sample; rolled-up ranges
 * draw the average with a min-to-max band. Timeouts (raw) or buckets with
 * lost pings (rolled up) are drawn as red ticks along the bottom.
 */
export default function RttChart({ history }: { history: History }) {
  const ref = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue("--accent").trim() || "#2457D6";
    const danger = css.getPropertyValue("--danger").trim() || "#D23F3F";
    const grid = css.getPropertyValue("--border-soft").trim() || "#EEF0F3";
    const text = css.getPropertyValue("--faint").trim() || "#8A93A0";

    const rolled = history.resolution !== "raw";
    const xs: number[] = [];
    const avg: (number | null)[] = [];
    const lo: (number | null)[] = [];
    const hi: (number | null)[] = [];
    const lossX: number[] = [];
    for (const p of history.points) {
      const t = Date.parse(p.ts) / 1000;
      xs.push(t);
      if (rolled) {
        const a = p as AggPoint;
        avg.push(a.avg);
        lo.push(a.min);
        hi.push(a.max);
        if (a.received < a.sent) lossX.push(t);
      } else {
        const r = p as RawPoint;
        avg.push(r.rtt_ms);
        if (r.rtt_ms === null) lossX.push(t);
      }
    }

    const series: uPlot.Series[] = [
      {},
      {
        label: rolled ? "avg ms" : "ms",
        stroke: accent,
        width: 2,
        spanGaps: false,
        points: { show: !rolled && xs.length < 200, size: 4 },
        value: (_u, v) => (v == null ? "—" : v < 10 ? v.toFixed(2) : v.toFixed(1)),
      },
    ];
    const data: uPlot.AlignedData = rolled ? [xs, avg, lo, hi] : [xs, avg];
    const bands: uPlot.Band[] = [];
    if (rolled) {
      series.push(
        {
          label: "min",
          stroke: "transparent",
          show: true,
          value: (_u, v) => (v == null ? "—" : v.toFixed(1)),
        },
        {
          label: "max",
          stroke: "transparent",
          show: true,
          value: (_u, v) => (v == null ? "—" : v.toFixed(1)),
        },
      );
      bands.push({ series: [3, 2], fill: accent + "22" });
    }

    const opts: uPlot.Options = {
      width: el.clientWidth,
      height: 260,
      series,
      bands,
      scales: {
        x: { time: true },
        y: { range: (_u, min, max) => [0, Math.max(1, max * 1.15, min)] },
      },
      axes: [
        {
          stroke: text,
          grid: { stroke: grid },
          ticks: { stroke: grid },
          font: "11px JetBrains Mono, monospace",
        },
        {
          stroke: text,
          grid: { stroke: grid },
          ticks: { stroke: grid },
          size: 50,
          font: "11px JetBrains Mono, monospace",
          values: (_u, vals) =>
            vals.map((v) => (v >= 100 ? v.toFixed(0) : v.toFixed(v < 10 ? 1 : 0))),
        },
      ],
      cursor: { drag: { x: false, y: false } },
      legend: { show: true },
      hooks: {
        draw: [
          (u) => {
            const ctx = u.ctx;
            const top = u.bbox.top;
            const h = u.bbox.height;
            ctx.save();
            ctx.fillStyle = danger;
            for (const t of lossX) {
              const x = u.valToPos(t, "x", true);
              ctx.fillRect(x - 1.5, top, 3, h);
            }
            ctx.restore();
          },
        ],
      },
    };

    plot.current?.destroy();
    plot.current = new uPlot(opts, data, el);
    const ro = new ResizeObserver(() => {
      if (plot.current && el.clientWidth > 0)
        plot.current.setSize({ width: el.clientWidth, height: 260 });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
  }, [history]);

  if (history.points.length === 0) {
    return <div className="empty">No samples in this range yet.</div>;
  }
  return <div className="chart" ref={ref} />;
}

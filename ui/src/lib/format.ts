export function fmtRtt(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 10) return ms.toFixed(1);
  return Math.round(ms).toString();
}

export function fmtPct(p: number | null | undefined): string {
  if (p === null || p === undefined) return "—";
  return (p >= 99.995 ? "100" : p.toFixed(2)) + "%";
}

export function fmtDuration(s: number | null | undefined): string {
  if (s === null || s === undefined) return "—";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** "12s ago", "6 min ago", "3d 4h" — relative to now. */
export function fmtAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  return `${fmtDuration(s)} ago`;
}

/** How long since `iso`, without the "ago". */
export function fmtFor(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  return fmtDuration(Math.max(0, Math.round((now - Date.parse(iso)) / 1000)));
}

const dt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
export function fmtDateTime(iso: string | null | undefined): string {
  return iso ? dt.format(new Date(iso)) : "—";
}

const dShort = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
export function fmtDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return dShort.format(new Date(y!, m! - 1, d!));
}

export function uptimeColor(p: number | null): string {
  if (p === null) return "var(--nodata)";
  if (p >= 99.9) return "var(--ok)";
  if (p >= 99) return "var(--warn)";
  return "var(--danger)";
}

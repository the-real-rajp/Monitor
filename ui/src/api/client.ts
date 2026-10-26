// Thin typed client for the PHP API. Cookies carry the session; the server
// checks Origin on mutations, which the browser sets automatically.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, e?.code ?? "error", e?.message ?? res.statusText);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T>(path: string, body?: unknown) => call<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => call<T>("PATCH", path, body),
  del: <T>(path: string) => call<T>("DELETE", path),
};

export function errorMessage(e: unknown, fallback = "Something went wrong"): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return fallback;
}

// ---- types mirroring the PHP handlers ------------------------------------

export type Role = "admin" | "viewer";
export type State = "up" | "down" | "unknown";
export type Source = "agent" | "web";
export type Method = "icmp" | "tcp";

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  created_at: string;
}

export interface Me {
  user: User;
  timezone: string;
}

export interface DeviceStatus {
  state: State;
  since: string | null;
  last_ts: string | null;
  last_rtt_ms: number | null;
  last_method: Method | null;
  consecutive_failures: number;
}

export interface Device {
  id: number;
  name: string;
  host: string;
  group_id: number | null;
  group_name: string | null;
  source: Source;
  agent_id: number | null;
  agent_name: string | null;
  interval_s: number;
  tcp_fallback_port: number | null;
  enabled: boolean;
  sort_order: number;
  notes: string | null;
  created_at: string;
  status: DeviceStatus;
}

export interface Group {
  id: number;
  name: string;
  sort_order: number;
  device_count: number;
}

export interface Agent {
  id: number;
  name: string;
  key_prefix: string;
  version: string;
  last_seen_at: string | null;
  last_ip: string;
  queue_depth: number;
  device_count: number;
  created_at: string;
  revoked_at: string | null;
  online: boolean;
  key?: string;
  install_command?: string;
}

export interface OverviewDevice {
  id: number;
  name: string;
  host: string;
  source: Source;
  agent_id: number | null;
  agent_name: string | null;
  interval_s: number;
  state: State;
  since: string | null;
  last_ts: string | null;
  last_rtt_ms: number | null;
  last_method: Method | null;
  uptime_24h: number | null;
  spark: (number | null)[] | null;
}

export interface Overview {
  generated_at: string;
  summary: {
    devices: number;
    up: number;
    down: number;
    unknown: number;
    uptime_30d: number | null;
    outages_30d: number;
    longest_outage_30d_s: number | null;
  };
  agents: Agent[];
  web_pinger: { method: string; last_run_at: string | null; last_error: string | null };
  groups: { id: number | null; name: string; devices: OverviewDevice[] }[];
}

export type Range = "1h" | "24h" | "7d" | "30d";

export interface RawPoint {
  ts: string;
  rtt_ms: number | null;
}
export interface AggPoint {
  ts: string;
  avg: number | null;
  min: number | null;
  max: number | null;
  p95?: number | null;
  sent: number;
  received: number;
}

export interface History {
  range: Range;
  resolution: "raw" | "minute" | "hour";
  from: string;
  to: string;
  points: RawPoint[] | AggPoint[];
  summary: {
    sent: number;
    received: number;
    uptime: number | null;
    avg_rtt_ms: number | null;
    outages: number;
    longest_outage_s: number | null;
  };
}

export interface Day {
  date: string;
  sent: number;
  received: number;
  uptime: number | null;
  outages: number;
  down_s: number;
}

export interface Outage {
  id: number;
  started_at: string;
  ended_at: string | null;
  duration_s: number | null;
  ongoing: boolean;
  detected_by: string;
}

export const INTERVALS = [10, 15, 30, 60, 120, 300, 600];

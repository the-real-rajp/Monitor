import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../lib/auth";

export default function Dashboard() {
  const { me } = useAuth();
  const version = useQuery({
    queryKey: ["version"],
    queryFn: async () => (await api.GET("/api/v1/version")).data,
  });
  const ready = useQuery({
    queryKey: ["readyz"],
    queryFn: async () => (await api.GET("/readyz")).data ?? null,
    refetchInterval: 30_000,
  });

  return (
    <>
      <h1>Overview</h1>
      <div className="card empty">
        <h2>Nothing is being monitored yet</h2>
        <p>
          Uptime checks arrive in phase 1, host metrics in phase 2 and application telemetry in
          phase 3. This page becomes the global status view as each lands.
        </p>
        {me?.user?.role === "admin" && (
          <p>
            In the meantime you can <Link to="/settings/users">invite your team</Link> and{" "}
            <Link to="/settings/api-keys">create API keys</Link> for collectors.
          </p>
        )}
      </div>

      <h2>System</h2>
      <table>
        <tbody>
          <tr>
            <th style={{ width: "12rem" }}>Server version</th>
            <td>{version.data?.version ?? "…"}</td>
          </tr>
          <tr>
            <th>Server uptime</th>
            <td>{version.data ? formatDuration(version.data.uptime_seconds) : "…"}</td>
          </tr>
          <tr>
            <th>PostgreSQL</th>
            <td>{statusPill(ready.data?.checks?.postgres)}</td>
          </tr>
          <tr>
            <th>ClickHouse</th>
            <td>{statusPill(ready.data?.checks?.clickhouse)}</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

function statusPill(v: string | undefined) {
  if (v === undefined) return <span className="pill">unknown</span>;
  if (v === "ok") return <span className="pill ok">ok</span>;
  return (
    <span className="pill danger" title={v}>
      failing
    </span>
  );
}

function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${seconds % 60}s`;
}

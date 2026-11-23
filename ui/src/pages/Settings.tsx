import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage, type SiteSettings } from "../api/client";
import { useAuth } from "../lib/auth";
import { REFRESH_CHOICES, refreshLabel } from "../lib/refresh";

export default function Settings() {
  const qc = useQueryClient();
  const { refresh } = useAuth();
  const q = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<SiteSettings>("/api/settings"),
    refetchInterval: false,
  });
  const [downThreshold, setDownThreshold] = useState(3);
  const [rawDays, setRawDays] = useState(7);
  const [refreshDefault, setRefreshDefault] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const loaded = q.data?.settings;
  useEffect(() => {
    if (!loaded) return;
    setDownThreshold(loaded.down_threshold);
    setRawDays(loaded.raw_retention_days);
    setRefreshDefault(loaded.refresh_default_s);
  }, [loaded]);

  const save = useMutation({
    mutationFn: () =>
      api.patch<SiteSettings>("/api/settings", {
        down_threshold: downThreshold,
        raw_retention_days: rawDays,
        refresh_default_s: refreshDefault,
      }),
    onSuccess: (data) => {
      qc.setQueryData(["settings"], data);
      setError(null);
      setSaved(true);
      void refresh(); // the default refresh interval rides on /api/auth/me
    },
    onError: (e) => {
      setSaved(false);
      setError(errorMessage(e));
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }
  const edit = () => setSaved(false);

  if (q.isLoading) return <div className="page-loading">Loading…</div>;
  if (q.isError || !q.data)
    return <div className="banner danger">Could not load the settings.</div>;
  const info = q.data.info;

  return (
    <>
      <div>
        <h1>Settings</h1>
        <p className="muted" style={{ margin: "4px 0 0", maxWidth: 760 }}>
          These apply to the whole site and everyone who uses it.
        </p>
      </div>

      <form className="card col" style={{ maxWidth: 640 }} onSubmit={submit}>
        <h2>Dashboard</h2>
        <label className="field">
          Auto-refresh, by default
          <select
            value={refreshDefault}
            onChange={(e) => {
              setRefreshDefault(Number(e.target.value));
              edit();
            }}
          >
            {REFRESH_CHOICES.map((s) => (
              <option key={s} value={s}>
                {s === 0 ? "Off" : `Every ${refreshLabel(s)}`}
              </option>
            ))}
          </select>
          <span className="small muted">
            How often open pages reload their data. Each person can pick their own in the top bar;
            this is what they get until they do.
          </span>
        </label>

        <h2>Monitoring</h2>
        <label className="field">
          Failed pings before a device is marked down
          <input
            type="number"
            min={1}
            max={10}
            value={downThreshold}
            onChange={(e) => {
              setDownThreshold(Number(e.target.value));
              edit();
            }}
            required
          />
          <span className="small muted">
            In a row. 1 reacts fastest but a single lost ping shows as an outage; 3 is the usual
            choice.
          </span>
        </label>
        <label className="field">
          Days to keep every individual ping
          <input
            type="number"
            min={1}
            max={31}
            value={rawDays}
            onChange={(e) => {
              setRawDays(Number(e.target.value));
              edit();
            }}
            required
          />
          <span className="small muted">
            Older pings are kept as hourly summaries, so charts and uptime still go back further.
            More days use more database space.
          </span>
        </label>

        {error && <div className="error">{error}</div>}
        {saved && <div className="small ok-ink">Settings saved.</div>}
        <button
          className="btn primary"
          type="submit"
          disabled={save.isPending}
          style={{ alignSelf: "flex-start" }}
        >
          Save settings
        </button>
      </form>

      <div className="table-card" style={{ maxWidth: 640 }}>
        <div className="head">
          <h2>About this install</h2>
        </div>
        <table>
          <tbody>
            <tr>
              <th style={{ width: "12rem" }}>Version</th>
              <td className="mono">
                {info.version}
                {info.build && <span className="muted"> (build {info.build})</span>}
              </td>
            </tr>
            <tr>
              <th>Site address</th>
              <td className="mono">{info.base_url}</td>
            </tr>
            <tr>
              <th>Time zone</th>
              <td>{info.timezone}</td>
            </tr>
            <tr>
              <th>Website ping method</th>
              <td>{info.web_ping_method}</td>
            </tr>
          </tbody>
        </table>
        <div className="foot small muted">
          Site address and time zone are set in <span className="mono">config.php</span> on the
          server. The ping method is detected by the website.
        </div>
      </div>
    </>
  );
}

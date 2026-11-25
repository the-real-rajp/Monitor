import { useQuery } from "@tanstack/react-query";
import { getHealth } from "../api/client";
import { fmtDuration } from "../lib/format";
import { useAuth } from "../lib/auth";
import { useRefresh } from "../lib/refresh";

/**
 * Warns on every page when the per-minute job has stopped or never ran.
 * Without it nothing on the dashboard updates, and nothing else would say so.
 */
export default function CronBanner() {
  const { me } = useAuth();
  const { ms } = useRefresh();
  const q = useQuery({ queryKey: ["health"], queryFn: getHealth, refetchInterval: ms });
  const h = q.data;
  if (!h || h.checks.database !== "ok") return null;

  // The server decides what counts as stale (three minutes), by its own clock,
  // so a browser with the wrong time cannot raise or hide the banner.
  const verdict = h.checks.cron ?? "";
  const never = verdict === "never ran";
  const age = /^last run (\d+)s ago$/.exec(verdict);
  if (!never && !age) return null;

  const isAdmin = me?.user.role === "admin";
  return (
    <div className="banner danger" role="alert">
      <span className="dot down" />
      <div>
        <strong>
          {never
            ? "This site's per-minute job has never run."
            : `This site's per-minute job last ran ${fmtDuration(Number(age![1]))} ago.`}
        </strong>{" "}
        Until it runs, website checks, uptime history and the states shown here are out of date.{" "}
        {isAdmin
          ? "Check the cron job in cPanel; the deploy guide has the line to add."
          : "Tell whoever runs this site."}
      </div>
    </div>
  );
}

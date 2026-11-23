<?php
declare(strict_types=1);

namespace Monitor\Handlers;

use Monitor\App;
use Monitor\Clock;
use Monitor\Http\Request;
use Monitor\Http\Response;

/**
 * GET /api/overview: everything the dashboard's front page needs in one
 * response. Reads device_status, the last hour of raw results for
 * sparklines, 24 hours of raw results for per-device uptime, and
 * ping_hourly plus events for the 30-day summary.
 */
final class OverviewHandlers
{
    public function __construct(private readonly App $app)
    {
    }

    public function overview(Request $req): Response
    {
        $db = $this->app->db;
        $now = Clock::now();

        $devices = $db->all(
            'SELECT d.*, g.name AS group_name, a.name AS agent_name,
                    s.state, s.since, s.last_ts, s.last_rtt_ms, s.last_method, s.consecutive_failures
               FROM devices d
               LEFT JOIN device_groups g ON g.id = d.group_id
               LEFT JOIN agents a ON a.id = d.agent_id
               LEFT JOIN device_status s ON s.device_id = d.id
              WHERE d.enabled = 1
              ORDER BY COALESCE(g.sort_order, 2147483647), g.name, d.sort_order, d.name',
        );

        // Per-device 24h uptime from raw results.
        $uptime24 = [];
        foreach ($db->all(
            'SELECT device_id, COUNT(*) AS sent, SUM(rtt_ms IS NOT NULL) AS received
               FROM ping_results WHERE ts >= ? GROUP BY device_id',
            [Clock::toDb($now - 86400)],
        ) as $r) {
            $uptime24[(int) $r['device_id']] = (int) $r['sent'] > 0 ? round(100 * (int) $r['received'] / (int) $r['sent'], 2) : null;
        }

        // Sparklines: 60 one-minute buckets of average RTT; null where every ping timed out, absent where no data.
        $sparkStart = $now - 3600;
        $buckets = [];
        foreach ($db->all(
            'SELECT device_id, FLOOR(UNIX_TIMESTAMP(ts) / 60) AS m, AVG(rtt_ms) AS avg_rtt, SUM(rtt_ms IS NULL) AS timeouts, COUNT(*) AS n
               FROM ping_results WHERE ts >= ? GROUP BY device_id, m',
            [Clock::toDb($sparkStart)],
        ) as $r) {
            $idx = (int) $r['m'] - intdiv($sparkStart, 60);
            if ($idx >= 0 && $idx < 60) {
                $buckets[(int) $r['device_id']][$idx] = $r['avg_rtt'] === null ? null : round((float) $r['avg_rtt'], 2);
            }
        }

        $groups = [];
        $counts = ['up' => 0, 'down' => 0, 'unknown' => 0];
        foreach ($devices as $d) {
            $id = (int) $d['id'];
            $state = $d['state'] ?? 'unknown';
            $counts[$state] = ($counts[$state] ?? 0) + 1;
            $spark = array_fill(0, 60, null);
            $hasAny = false;
            foreach ($buckets[$id] ?? [] as $i => $v) {
                $spark[$i] = $v;
                $hasAny = true;
            }
            $gid = $d['group_id'] === null ? 0 : (int) $d['group_id'];
            $groups[$gid] ??= ['id' => $gid === 0 ? null : $gid, 'name' => $d['group_name'] ?? 'Ungrouped', 'devices' => []];
            $groups[$gid]['devices'][] = [
                'id'                => $id,
                'name'              => $d['name'],
                'host'              => $d['host'],
                'source'            => $d['source'],
                'agent_id'          => $d['agent_id'] === null ? null : (int) $d['agent_id'],
                'agent_name'        => $d['agent_name'],
                'interval_s'        => (int) $d['interval_s'],
                'state'             => $state,
                'since'             => Clock::iso($d['since']),
                'last_ts'           => Clock::iso($d['last_ts']),
                'last_rtt_ms'       => $d['last_rtt_ms'] === null ? null : (float) $d['last_rtt_ms'],
                'last_method'       => $d['last_method'],
                'uptime_24h'        => $uptime24[$id] ?? null,
                'spark'             => $hasAny ? $spark : null,
            ];
        }

        $hourly = $db->one(
            'SELECT SUM(sent) AS sent, SUM(received) AS received FROM ping_hourly WHERE hour >= ?',
            [Clock::toDb($now - 30 * 86400)],
        );
        $ev = $db->one(
            'SELECT COUNT(*) AS outages, MAX(COALESCE(duration_s, TIMESTAMPDIFF(SECOND, started_at, UTC_TIMESTAMP()))) AS longest
               FROM events WHERE started_at >= ?',
            [Clock::toDb($now - 30 * 86400)],
        );

        $agents = array_map(fn ($a) => AgentHandlers::toApi($a, $now), $db->all(
            'SELECT a.*, (SELECT COUNT(*) FROM devices d WHERE d.agent_id = a.id AND d.enabled = 1) AS device_count
               FROM agents a WHERE a.revoked_at IS NULL ORDER BY a.name',
        ));
        $cron = $db->one('SELECT * FROM cron_runs ORDER BY id DESC LIMIT 1');

        return Response::json([
            'generated_at' => gmdate('Y-m-d\TH:i:s\Z', $now),
            'summary' => [
                'devices'              => count($devices),
                'up'                   => $counts['up'],
                'down'                 => $counts['down'],
                'unknown'              => $counts['unknown'],
                'uptime_30d'           => ($hourly['sent'] ?? 0) > 0 ? round(100 * (int) $hourly['received'] / (int) $hourly['sent'], 2) : null,
                'outages_30d'          => (int) ($ev['outages'] ?? 0),
                'longest_outage_30d_s' => $ev['longest'] === null ? null : (int) $ev['longest'],
            ],
            'agents' => $agents,
            'web_pinger' => [
                'method'      => $this->app->settings->get('web_ping_method', 'unknown'),
                'last_run_at' => Clock::iso($cron['started_at'] ?? null),
                'last_error'  => $cron['error'] ?? null,
            ],
            'groups' => array_values($groups),
        ]);
    }
}

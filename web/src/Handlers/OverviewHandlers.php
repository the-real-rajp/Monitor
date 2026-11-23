<?php
declare(strict_types=1);

namespace Monitor\Handlers;

use Monitor\App;
use Monitor\Clock;
use Monitor\Http\Request;
use Monitor\Http\Response;

/**
 * GET /api/overview: everything the dashboard's front page needs in one
 * response. Reads device_status, 24 hours of raw results for per-device
 * uptime, and ping_hourly plus events for the daily strips and the 30-day
 * summary.
 */
final class OverviewHandlers
{
    /** Days of daily uptime returned per device. */
    private const DAYS = 30;

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

        // Daily uptime for the last 30 calendar days in the site's time zone, per device.
        // Day boundaries are computed here so the grouping is right across DST changes.
        $tz = $this->app->timezone();
        $today = (new \DateTimeImmutable('@' . $now))->setTimezone($tz)->setTime(0, 0);
        $utc = new \DateTimeZone('UTC');
        $dates = [];
        $bounds = [];
        $args = [];
        for ($i = 0; $i < self::DAYS; $i++) {
            $start = $today->sub(new \DateInterval('P' . (self::DAYS - 1 - $i) . 'D'));
            $dates[] = $start->format('Y-m-d');
            $bounds[] = 'SELECT ? AS idx, ? AS s, ? AS e';
            array_push(
                $args,
                $i,
                $start->setTimezone($utc)->format('Y-m-d H:i:s'),
                $start->add(new \DateInterval('P1D'))->setTimezone($utc)->format('Y-m-d H:i:s'),
            );
        }
        $daily = [];
        foreach ($db->all(
            'SELECT h.device_id, b.idx, SUM(h.sent) AS sent, SUM(h.received) AS received
               FROM (' . implode(' UNION ALL ', $bounds) . ') b
               JOIN ping_hourly h ON h.hour >= b.s AND h.hour < b.e
              GROUP BY h.device_id, b.idx',
            $args,
        ) as $r) {
            $daily[(int) $r['device_id']][(int) $r['idx']] = [(int) $r['sent'], (int) $r['received']];
        }

        $groups = [];
        $counts = ['up' => 0, 'down' => 0, 'unknown' => 0];
        foreach ($devices as $d) {
            $id = (int) $d['id'];
            $state = $d['state'] ?? 'unknown';
            $counts[$state] = ($counts[$state] ?? 0) + 1;
            $days = array_fill(0, self::DAYS, null);
            $sent = 0;
            $received = 0;
            foreach ($daily[$id] ?? [] as $i => [$ds, $dr]) {
                if ($ds > 0) {
                    $days[$i] = round(100 * $dr / $ds, 2);
                    $sent += $ds;
                    $received += $dr;
                }
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
                'uptime_30d'        => $sent > 0 ? round(100 * $received / $sent, 2) : null,
                'days'              => $days,
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
            'retention' => [
                'raw_days'    => $this->app->settings->rawRetentionDays(),
                'hourly_days' => $this->app->settings->hourlyRetentionDays(),
            ],
            'timezone' => $tz->getName(),
            'days' => $dates,
            'groups' => array_values($groups),
        ]);
    }
}

<?php
declare(strict_types=1);

namespace Monitor\Handlers;

use Monitor\App;
use Monitor\Clock;
use Monitor\Db;
use Monitor\Http\HttpError;
use Monitor\Http\Request;
use Monitor\Http\Response;
use Monitor\Ping\WebPinger;

final class DeviceHandlers
{
    private const INTERVALS = [10, 15, 30, 60, 120, 300, 600];

    public function __construct(private readonly App $app)
    {
    }

    // ---- CRUD -----------------------------------------------------------

    public function list(Request $req): Response
    {
        $rows = $this->app->db->all($this->selectSql() . ' ORDER BY COALESCE(g.sort_order, 2147483647), g.name, d.sort_order, d.name');
        return Response::json(['devices' => array_map([$this, 'toApi'], $rows)]);
    }

    public function get(Request $req): Response
    {
        return Response::json($this->toApi($this->load($req->intParam('id'))));
    }

    public function create(Request $req): Response
    {
        $in = $req->json(['name', 'host', 'group_id', 'source', 'agent_id', 'interval_s', 'tcp_fallback_port', 'enabled', 'notes']);
        $v = $this->validate($in, null);
        $db = $this->app->db;
        $id = $db->transaction(function (Db $db) use ($v): int {
            $order = (int) $db->value('SELECT COALESCE(MAX(sort_order), 0) + 1 FROM devices WHERE group_id <=> ?', [$v['group_id']]);
            $db->exec(
                'INSERT INTO devices (name, host, group_id, source, agent_id, interval_s, tcp_fallback_port, enabled, sort_order, notes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [$v['name'], $v['host'], $v['group_id'], $v['source'], $v['agent_id'], $v['interval_s'], $v['tcp_fallback_port'], $v['enabled'], $order, $v['notes']],
            );
            $id = $db->lastId();
            $db->exec('INSERT INTO device_status (device_id) VALUES (?)', [$id]);
            return $id;
        });
        return Response::json($this->toApi($this->load($id)), 201);
    }

    public function update(Request $req): Response
    {
        $id = $req->intParam('id');
        $cur = $this->load($id);
        $in = $req->json(['name', 'host', 'group_id', 'source', 'agent_id', 'interval_s', 'tcp_fallback_port', 'enabled', 'notes']);
        $v = $this->validate($in, $cur);
        $this->app->db->exec(
            'UPDATE devices SET name = ?, host = ?, group_id = ?, source = ?, agent_id = ?, interval_s = ?, tcp_fallback_port = ?, enabled = ?, notes = ? WHERE id = ?',
            [$v['name'], $v['host'], $v['group_id'], $v['source'], $v['agent_id'], $v['interval_s'], $v['tcp_fallback_port'], $v['enabled'], $v['notes'], $id],
        );
        if ($v['host'] !== $cur['host'] || $v['source'] !== $cur['source']) {
            // A different target is a different history head; forget the streak.
            $this->app->db->exec("UPDATE device_status SET state = 'unknown', consecutive_failures = 0, since = UTC_TIMESTAMP() WHERE device_id = ?", [$id]);
        }
        return Response::json($this->toApi($this->load($id)));
    }

    public function delete(Request $req): Response
    {
        $id = $req->intParam('id');
        $this->load($id);
        $this->app->db->exec('DELETE FROM devices WHERE id = ?', [$id]); // cascades to results, status, events
        return Response::noContent();
    }

    /** POST /api/devices/reorder {"ids": [..]} sets sort_order by position. */
    public function reorder(Request $req): Response
    {
        $in = $req->json(['ids']);
        $ids = $in['ids'] ?? null;
        if (!is_array($ids) || $ids === [] || count($ids) > 1000) {
            throw HttpError::badRequest('ids must be a non-empty list');
        }
        $this->app->db->transaction(function (Db $db) use ($ids) {
            foreach (array_values($ids) as $i => $id) {
                if (!is_int($id) || $id <= 0) {
                    throw HttpError::badRequest('ids must be positive integers');
                }
                $db->exec('UPDATE devices SET sort_order = ? WHERE id = ?', [$i, $id]);
            }
        });
        return Response::noContent();
    }

    // ---- history --------------------------------------------------------

    /**
     * GET /api/devices/{id}/history?range=1h|24h|7d|30d
     * 1h: raw samples. 24h: one-minute buckets. 7d, 30d: hourly rollups.
     */
    public function history(Request $req): Response
    {
        $id = $req->intParam('id');
        $this->load($id);
        $range = $req->query('range', '24h');
        $db = $this->app->db;
        $now = Clock::now();
        switch ($range) {
            case '1h':
                $from = $now - 3600;
                $points = array_map(fn ($r) => ['ts' => Clock::iso($r['ts']), 'rtt_ms' => $r['rtt_ms'] === null ? null : (float) $r['rtt_ms']], $db->all(
                    'SELECT ts, rtt_ms FROM ping_results WHERE device_id = ? AND ts >= ? ORDER BY ts',
                    [$id, Clock::toDb($from)],
                ));
                $resolution = 'raw';
                break;
            case '24h':
                $from = $now - 86400;
                $points = array_map(fn ($r) => [
                    'ts'       => gmdate('Y-m-d\TH:i:s\Z', (int) $r['m'] * 60),
                    'avg'      => $r['avg_rtt'] === null ? null : round((float) $r['avg_rtt'], 2),
                    'min'      => $r['min_rtt'] === null ? null : (float) $r['min_rtt'],
                    'max'      => $r['max_rtt'] === null ? null : (float) $r['max_rtt'],
                    'sent'     => (int) $r['sent'],
                    'received' => (int) $r['received'],
                ], $db->all(
                    'SELECT FLOOR(UNIX_TIMESTAMP(ts) / 60) AS m, AVG(rtt_ms) AS avg_rtt, MIN(rtt_ms) AS min_rtt, MAX(rtt_ms) AS max_rtt,
                            COUNT(*) AS sent, SUM(rtt_ms IS NOT NULL) AS received
                       FROM ping_results WHERE device_id = ? AND ts >= ? GROUP BY m ORDER BY m',
                    [$id, Clock::toDb($from)],
                ));
                $resolution = 'minute';
                break;
            case '7d':
            case '30d':
                $from = $now - ($range === '7d' ? 7 : 30) * 86400;
                $points = array_map(fn ($r) => [
                    'ts'       => Clock::iso($r['hour']),
                    'avg'      => $r['rtt_avg'] === null ? null : (float) $r['rtt_avg'],
                    'min'      => $r['rtt_min'] === null ? null : (float) $r['rtt_min'],
                    'max'      => $r['rtt_max'] === null ? null : (float) $r['rtt_max'],
                    'p95'      => $r['rtt_p95'] === null ? null : (float) $r['rtt_p95'],
                    'sent'     => (int) $r['sent'],
                    'received' => (int) $r['received'],
                ], $db->all(
                    'SELECT * FROM ping_hourly WHERE device_id = ? AND hour >= ? ORDER BY hour',
                    [$id, Clock::toDb($from - $from % 3600)],
                ));
                $resolution = 'hour';
                break;
            default:
                throw HttpError::badRequest('range must be 1h, 24h, 7d or 30d');
        }

        // Summary over the same window.
        $raw = $range === '1h' || $range === '24h';
        $agg = $raw
            ? $db->one('SELECT COUNT(*) AS sent, SUM(rtt_ms IS NOT NULL) AS received, AVG(rtt_ms) AS avg_rtt FROM ping_results WHERE device_id = ? AND ts >= ?', [$id, Clock::toDb($from)])
            : $db->one('SELECT SUM(sent) AS sent, SUM(received) AS received, SUM(rtt_avg * received) / NULLIF(SUM(received), 0) AS avg_rtt FROM ping_hourly WHERE device_id = ? AND hour >= ?', [$id, Clock::toDb($from - $from % 3600)]);
        $ev = $db->one(
            'SELECT COUNT(*) AS outages, MAX(COALESCE(duration_s, TIMESTAMPDIFF(SECOND, started_at, UTC_TIMESTAMP()))) AS longest
               FROM events WHERE device_id = ? AND (ended_at IS NULL OR ended_at >= ?)',
            [$id, Clock::toDb($from)],
        );
        return Response::json([
            'range'      => $range,
            'resolution' => $resolution,
            'from'       => gmdate('Y-m-d\TH:i:s\Z', $from),
            'to'         => gmdate('Y-m-d\TH:i:s\Z', $now),
            'points'     => $points,
            'summary'    => [
                'sent'             => (int) ($agg['sent'] ?? 0),
                'received'         => (int) ($agg['received'] ?? 0),
                'uptime'           => ($agg['sent'] ?? 0) > 0 ? round(100 * (int) $agg['received'] / (int) $agg['sent'], 2) : null,
                'avg_rtt_ms'       => $agg['avg_rtt'] === null ? null : round((float) $agg['avg_rtt'], 2),
                'outages'          => (int) ($ev['outages'] ?? 0),
                'longest_outage_s' => $ev['longest'] === null ? null : (int) $ev['longest'],
            ],
        ]);
    }

    /**
     * GET /api/devices/{id}/days?days=30: per local calendar day, for the
     * uptime strip. Day boundaries follow the configured time zone.
     */
    public function days(Request $req): Response
    {
        $id = $req->intParam('id');
        $this->load($id);
        $days = max(1, min(400, (int) ($req->query('days', '30') ?? 30)));
        $tz = $this->app->timezone();
        $today = (new \DateTimeImmutable('@' . Clock::now()))->setTimezone($tz)->setTime(0, 0);
        $first = $today->sub(new \DateInterval('P' . ($days - 1) . 'D'));

        $byDay = [];
        for ($i = 0; $i < $days; $i++) {
            $d = $first->add(new \DateInterval("P{$i}D"))->format('Y-m-d');
            $byDay[$d] = ['date' => $d, 'sent' => 0, 'received' => 0, 'uptime' => null, 'outages' => 0, 'down_s' => 0];
        }
        $fromUtc = $first->setTimezone(new \DateTimeZone('UTC'))->format('Y-m-d H:i:s');
        foreach ($this->app->db->all('SELECT hour, sent, received FROM ping_hourly WHERE device_id = ? AND hour >= ?', [$id, $fromUtc]) as $r) {
            $d = (new \DateTimeImmutable($r['hour'] . ' UTC'))->setTimezone($tz)->format('Y-m-d');
            if (isset($byDay[$d])) {
                $byDay[$d]['sent'] += (int) $r['sent'];
                $byDay[$d]['received'] += (int) $r['received'];
            }
        }
        foreach ($this->app->db->all('SELECT started_at, ended_at, duration_s FROM events WHERE device_id = ? AND (ended_at IS NULL OR ended_at >= ?)', [$id, $fromUtc]) as $e) {
            $d = (new \DateTimeImmutable($e['started_at'] . ' UTC'))->setTimezone($tz)->format('Y-m-d');
            if (isset($byDay[$d])) {
                $byDay[$d]['outages']++;
                $byDay[$d]['down_s'] += (int) ($e['duration_s'] ?? (Clock::now() - Clock::fromDb($e['started_at'])));
            }
        }
        foreach ($byDay as &$d) {
            $d['uptime'] = $d['sent'] > 0 ? round(100 * $d['received'] / $d['sent'], 2) : null;
        }
        unset($d);
        return Response::json(['timezone' => $tz->getName(), 'days' => array_values($byDay)]);
    }

    public function events(Request $req): Response
    {
        $id = $req->intParam('id');
        $this->load($id);
        $days = max(1, min(400, (int) ($req->query('days', '30') ?? 30)));
        $rows = $this->app->db->all(
            'SELECT * FROM events WHERE device_id = ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at DESC LIMIT 500',
            [$id, Clock::toDb(Clock::now() - $days * 86400)],
        );
        return Response::json(['events' => array_map(fn ($e) => [
            'id'          => (int) $e['id'],
            'started_at'  => Clock::iso($e['started_at']),
            'ended_at'    => Clock::iso($e['ended_at']),
            'duration_s'  => $e['duration_s'] === null ? null : (int) $e['duration_s'],
            'ongoing'     => $e['ended_at'] === null,
            'detected_by' => $e['detected_by'],
        ], $rows)]);
    }

    // ---- helpers --------------------------------------------------------

    private function selectSql(): string
    {
        return 'SELECT d.*, g.name AS group_name, a.name AS agent_name,
                       s.state, s.since, s.last_ts, s.last_rtt_ms, s.last_method, s.consecutive_failures
                  FROM devices d
                  LEFT JOIN device_groups g ON g.id = d.group_id
                  LEFT JOIN agents a ON a.id = d.agent_id
                  LEFT JOIN device_status s ON s.device_id = d.id';
    }

    /** @return array<string,mixed> */
    private function load(int $id): array
    {
        return $this->app->db->one($this->selectSql() . ' WHERE d.id = ?', [$id]) ?? throw HttpError::notFound('device not found');
    }

    /**
     * @param array<string,mixed> $in
     * @param array<string,mixed>|null $cur existing row for PATCH, null for create
     * @return array<string,mixed>
     */
    private function validate(array $in, ?array $cur): array
    {
        $get = fn (string $k, mixed $default) => array_key_exists($k, $in) ? $in[$k] : ($cur[$k] ?? $default);

        $name = trim((string) $get('name', ''));
        if ($name === '' || mb_strlen($name) > 100) {
            throw HttpError::badRequest('name is required and at most 100 characters');
        }
        $host = trim((string) $get('host', ''));
        if (!WebPinger::validHost($host)) {
            throw HttpError::badRequest('host must be a hostname or IP address');
        }
        $source = (string) $get('source', 'agent');
        if (!in_array($source, ['agent', 'web'], true)) {
            throw HttpError::badRequest('source must be agent or web');
        }
        $groupId = $get('group_id', null);
        if ($groupId !== null) {
            if (!is_int($groupId) || $this->app->db->value('SELECT id FROM device_groups WHERE id = ?', [$groupId]) === null) {
                throw HttpError::badRequest('group_id does not exist');
            }
        }
        $agentId = $get('agent_id', null);
        if ($source === 'agent') {
            if (!is_int($agentId) || $this->app->db->value('SELECT id FROM agents WHERE id = ? AND revoked_at IS NULL', [$agentId]) === null) {
                throw HttpError::badRequest('agent_id must name an active proxy when source is agent');
            }
        } else {
            $agentId = null;
        }
        $interval = $get('interval_s', $source === 'web' ? 60 : 30);
        if (!is_int($interval) || !in_array($interval, self::INTERVALS, true)) {
            throw HttpError::badRequest('interval_s must be one of ' . implode(', ', self::INTERVALS));
        }
        if ($source === 'web' && $interval < 60) {
            throw HttpError::badRequest('website-pinged devices cannot be checked more often than every 60 seconds');
        }
        $port = $get('tcp_fallback_port', null);
        if ($source === 'web') {
            if ($port !== null && (!is_int($port) || $port < 1 || $port > 65535)) {
                throw HttpError::badRequest('tcp_fallback_port must be 1 to 65535');
            }
        } else {
            $port = null;
        }
        $enabled = $get('enabled', true);
        if (!is_bool($enabled)) {
            throw HttpError::badRequest('enabled must be true or false');
        }
        $notes = $get('notes', null);
        if ($notes !== null && (!is_string($notes) || mb_strlen($notes) > 2000)) {
            throw HttpError::badRequest('notes must be a string of at most 2000 characters');
        }
        return [
            'name' => $name, 'host' => $host, 'group_id' => $groupId, 'source' => $source, 'agent_id' => $agentId,
            'interval_s' => $interval, 'tcp_fallback_port' => $port, 'enabled' => $enabled ? 1 : 0, 'notes' => $notes === '' ? null : $notes,
        ];
    }

    /** @param array<string,mixed> $d */
    public function toApi(array $d): array
    {
        return [
            'id'                => (int) $d['id'],
            'name'              => $d['name'],
            'host'              => $d['host'],
            'group_id'          => $d['group_id'] === null ? null : (int) $d['group_id'],
            'group_name'        => $d['group_name'] ?? null,
            'source'            => $d['source'],
            'agent_id'          => $d['agent_id'] === null ? null : (int) $d['agent_id'],
            'agent_name'        => $d['agent_name'] ?? null,
            'interval_s'        => (int) $d['interval_s'],
            'tcp_fallback_port' => $d['tcp_fallback_port'] === null ? null : (int) $d['tcp_fallback_port'],
            'enabled'           => (bool) $d['enabled'],
            'sort_order'        => (int) $d['sort_order'],
            'notes'             => $d['notes'],
            'created_at'        => Clock::iso($d['created_at']),
            'status'            => [
                'state'                => $d['state'] ?? 'unknown',
                'since'                => Clock::iso($d['since'] ?? null),
                'last_ts'              => Clock::iso($d['last_ts'] ?? null),
                'last_rtt_ms'          => ($d['last_rtt_ms'] ?? null) === null ? null : (float) $d['last_rtt_ms'],
                'last_method'          => $d['last_method'] ?? null,
                'consecutive_failures' => (int) ($d['consecutive_failures'] ?? 0),
            ],
        ];
    }
}

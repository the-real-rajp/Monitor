<?php
declare(strict_types=1);

namespace Monitor\Handlers;

use Monitor\App;
use Monitor\Clock;
use Monitor\Http\HttpError;
use Monitor\Http\Request;
use Monitor\Http\Response;
use Monitor\Status\StatusEngine;

/** The three endpoints a proxy calls. All authenticated by agent key. */
final class AgentApiHandlers
{
    public const MAX_BATCH = 5000;

    public function __construct(private readonly App $app)
    {
    }

    /**
     * GET /api/agent/devices. The list the proxy should ping. Carries an
     * ETag so an unchanged list costs a 304. Also counts as a heartbeat.
     */
    public function devices(Request $req): Response
    {
        $agent = $req->principal->agent;
        $this->touch((int) $agent['id'], $req->ip, null);
        $rows = $this->app->db->all(
            'SELECT id, host, interval_s FROM devices WHERE agent_id = ? AND enabled = 1 ORDER BY id',
            [$agent['id']],
        );
        $devices = array_map(fn ($r) => ['id' => (int) $r['id'], 'host' => $r['host'], 'interval_s' => (int) $r['interval_s']], $rows);
        $body = ['devices' => $devices, 'generated_at' => gmdate('Y-m-d\TH:i:s\Z', Clock::now())];
        $etag = '"' . substr(hash('sha256', json_encode($devices, JSON_THROW_ON_ERROR)), 0, 32) . '"';
        if ($req->header('if-none-match') === $etag) {
            return (new Response(304))->withHeader('ETag', $etag);
        }
        return Response::json($body)->withHeader('ETag', $etag);
    }

    /**
     * POST /api/agent/results {"results": [{"device_id", "ts", "rtt_ms"}]}
     * ts is RFC 3339 or unix seconds; rtt_ms null means timeout. Idempotent
     * on (device_id, ts). Results for devices not assigned to this proxy are
     * rejected and counted, never silently dropped.
     */
    public function results(Request $req): Response
    {
        $agent = $req->principal->agent;
        $in = $req->json(['results', 'queue_depth']);
        $results = $in['results'] ?? null;
        if (!is_array($results) || !array_is_list($results)) {
            throw HttpError::badRequest('results must be a list');
        }
        if (count($results) > self::MAX_BATCH) {
            throw HttpError::badRequest('at most ' . self::MAX_BATCH . ' results per request');
        }
        $allowed = array_flip(array_map('intval', array_column(
            $this->app->db->all('SELECT id FROM devices WHERE agent_id = ? AND enabled = 1', [$agent['id']]),
            'id',
        )));

        $byDevice = [];
        $rejected = 0;
        foreach ($results as $r) {
            $deviceId = $r['device_id'] ?? null;
            $ts = Clock::parseIncoming($r['ts'] ?? null);
            $rtt = $r['rtt_ms'] ?? null;
            if (!is_int($deviceId) || !isset($allowed[$deviceId]) || $ts === null || !($rtt === null || is_int($rtt) || is_float($rtt)) || ($rtt !== null && ($rtt < 0 || $rtt > 60000))) {
                $rejected++;
                continue;
            }
            $byDevice[$deviceId][] = ['ts' => $ts, 'rtt_ms' => $rtt === null ? null : round((float) $rtt, 2), 'method' => 'icmp'];
        }

        $engine = new StatusEngine($this->app->db, $this->app->settings);
        $stored = 0;
        foreach ($byDevice as $deviceId => $list) {
            $stored += $engine->ingest($deviceId, $list, 'proxy ' . $agent['name']);
        }
        $this->touch((int) $agent['id'], $req->ip, isset($in['queue_depth']) && is_int($in['queue_depth']) ? $in['queue_depth'] : null);

        return Response::json([
            'accepted' => count($results) - $rejected,
            'stored'   => $stored,
            'rejected' => $rejected,
        ]);
    }

    /** POST /api/agent/heartbeat {"version", "uptime_s", "queue_depth"} */
    public function heartbeat(Request $req): Response
    {
        $agent = $req->principal->agent;
        $in = $req->json(['version', 'uptime_s', 'queue_depth']);
        $version = isset($in['version']) && is_string($in['version']) ? mb_substr($in['version'], 0, 40) : null;
        $queue = isset($in['queue_depth']) && is_int($in['queue_depth']) ? max(0, $in['queue_depth']) : null;
        $this->touch((int) $agent['id'], $req->ip, $queue, $version);
        return Response::json([
            'server_time'           => gmdate('Y-m-d\TH:i:s\Z', Clock::now()),
            'results_max_batch'     => self::MAX_BATCH,
            'devices_poll_interval' => 60,
        ]);
    }

    private function touch(int $agentId, string $ip, ?int $queueDepth, ?string $version = null): void
    {
        $sets = ['last_seen_at = UTC_TIMESTAMP()', 'last_ip = ?'];
        $params = [mb_substr($ip, 0, 45)];
        if ($queueDepth !== null) {
            $sets[] = 'queue_depth = ?';
            $params[] = $queueDepth;
        }
        if ($version !== null) {
            $sets[] = 'version = ?';
            $params[] = $version;
        }
        $params[] = $agentId;
        $this->app->db->exec('UPDATE agents SET ' . implode(', ', $sets) . ' WHERE id = ?', $params);
    }
}

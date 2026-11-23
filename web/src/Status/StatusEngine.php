<?php
declare(strict_types=1);

namespace Monitor\Status;

use Monitor\Clock;
use Monitor\Db;
use Monitor\Settings;

/**
 * The one place ping results enter the system. Both the website pinger and
 * the agent ingest endpoint call ingest(); it stores raw samples, marks the
 * touched hours for rollup, and drives the up/down state machine:
 *
 *   unknown/up  --N consecutive timeouts-->  down   (opens an events row)
 *   down        --one success-->             up     (closes the events row)
 *
 * The outage is dated from the first timeout of the streak, not from the
 * Nth that confirmed it, so durations reflect when the device actually
 * stopped answering.
 *
 * Results are processed in timestamp order. A result older than the last
 * one already seen for the device is stored for history but does not move
 * state, so an agent backfilling after an outage cannot flip the current
 * status backwards.
 */
final class StatusEngine
{
    public function __construct(private readonly Db $db, private readonly Settings $settings)
    {
    }

    /**
     * @param list<array{ts:string, rtt_ms:float|null, method:string}> $results ts as MySQL UTC DATETIME
     * @return int number of new raw rows stored
     */
    public function ingest(int $deviceId, array $results, string $detectedBy): int
    {
        if ($results === []) {
            return 0;
        }
        usort($results, fn ($a, $b) => strcmp($a['ts'], $b['ts']));
        $threshold = $this->settings->downThreshold();

        return $this->db->transaction(function (Db $db) use ($deviceId, $results, $detectedBy, $threshold): int {
            $status = $db->one('SELECT * FROM device_status WHERE device_id = ? FOR UPDATE', [$deviceId]);
            if ($status === null) {
                $db->exec('INSERT IGNORE INTO device_status (device_id) VALUES (?)', [$deviceId]);
                $status = $db->one('SELECT * FROM device_status WHERE device_id = ? FOR UPDATE', [$deviceId]);
            }
            $state = $status['state'];
            $since = $status['since'];
            $fails = (int) $status['consecutive_failures'];
            $streakStart = $status['streak_start'];
            $lastTs = $status['last_ts'];
            $lastRtt = $status['last_rtt_ms'];
            $lastMethod = $status['last_method'];

            $insert = $db->pdo->prepare('INSERT IGNORE INTO ping_results (device_id, ts, rtt_ms, method) VALUES (?, ?, ?, ?)');
            $dirty = $db->pdo->prepare('INSERT IGNORE INTO rollup_dirty (device_id, hour) VALUES (?, ?)');
            $stored = 0;
            $hours = [];

            foreach ($results as $r) {
                $insert->execute([$deviceId, $r['ts'], $r['rtt_ms'], $r['method']]);
                if ($insert->rowCount() === 0) {
                    continue; // duplicate (device_id, ts): already processed
                }
                $stored++;
                $hours[substr($r['ts'], 0, 13) . ':00:00'] = true;

                if ($lastTs !== null && strcmp($r['ts'], $lastTs) <= 0) {
                    continue; // backfill behind the current head: history only
                }
                $lastTs = $r['ts'];
                $lastRtt = $r['rtt_ms'];
                $lastMethod = $r['method'];

                if ($r['rtt_ms'] === null) {
                    $fails++;
                    $streakStart ??= $r['ts'];
                    if ($state !== 'down' && $fails >= $threshold) {
                        $state = 'down';
                        $since = $streakStart;
                        $db->exec(
                            'INSERT INTO events (device_id, started_at, detected_by) VALUES (?, ?, ?)',
                            [$deviceId, $streakStart, $detectedBy . ', ' . $threshold . ' consecutive timeouts'],
                        );
                    }
                } else {
                    $fails = 0;
                    $streakStart = null;
                    if ($state === 'down') {
                        $db->exec(
                            'UPDATE events SET ended_at = ?, duration_s = TIMESTAMPDIFF(SECOND, started_at, ?)
                              WHERE device_id = ? AND ended_at IS NULL',
                            [$r['ts'], $r['ts'], $deviceId],
                        );
                    }
                    if ($state !== 'up') {
                        $state = 'up';
                        $since = $r['ts'];
                    }
                }
            }

            foreach (array_keys($hours) as $hour) {
                $dirty->execute([$deviceId, $hour]);
            }
            $db->exec(
                'UPDATE device_status SET state = ?, since = ?, consecutive_failures = ?, streak_start = ?, last_ts = ?, last_rtt_ms = ?, last_method = ?
                  WHERE device_id = ?',
                [$state, $since, $fails, $streakStart, $lastTs, $lastRtt, $lastMethod, $deviceId],
            );
            return $stored;
        });
    }

    /**
     * Marks devices whose source has gone silent as unknown: an agent that
     * has not posted for a while, or a web device the cron has not reached.
     * Called by cron. Does not open an outage; silence is not a timeout.
     */
    public function markStale(int $agentSilenceS = 180, int $webSilenceS = 180): int
    {
        $n = $this->db->exec(
            "UPDATE device_status s JOIN devices d ON d.id = s.device_id
               LEFT JOIN agents a ON a.id = d.agent_id
                SET s.state = 'unknown', s.since = UTC_TIMESTAMP(), s.consecutive_failures = 0, s.streak_start = NULL
              WHERE s.state <> 'unknown' AND d.enabled = 1 AND d.source = 'agent'
                AND (a.last_seen_at IS NULL OR a.last_seen_at < UTC_TIMESTAMP() - INTERVAL ? SECOND)",
            [$agentSilenceS],
        );
        $n += $this->db->exec(
            "UPDATE device_status s JOIN devices d ON d.id = s.device_id
                SET s.state = 'unknown', s.since = UTC_TIMESTAMP(), s.consecutive_failures = 0, s.streak_start = NULL
              WHERE s.state <> 'unknown' AND d.enabled = 1 AND d.source = 'web'
                AND (s.last_ts IS NULL OR s.last_ts < UTC_TIMESTAMP() - INTERVAL ? SECOND)",
            [$webSilenceS],
        );
        return $n;
    }
}

<?php
declare(strict_types=1);

namespace Monitor;

/**
 * Hourly rollups and retention. Runs from cron.
 *
 * Rollup recomputes exactly the (device, hour) pairs that ingest marked in
 * rollup_dirty, so backfilled results from an agent land in the right hour
 * and nothing is recomputed needlessly. p95 is computed in PHP because
 * MySQL has no percentile function; an hour holds at most 360 samples.
 */
final class Rollup
{
    public function __construct(private readonly Db $db, private readonly Settings $settings)
    {
    }

    /** @return int number of (device, hour) rows recomputed */
    public function run(int $limit = 500): int
    {
        $dirty = $this->db->all('SELECT device_id, hour FROM rollup_dirty ORDER BY hour LIMIT ' . $limit);
        foreach ($dirty as $d) {
            $this->recompute((int) $d['device_id'], (string) $d['hour']);
            $this->db->exec('DELETE FROM rollup_dirty WHERE device_id = ? AND hour = ?', [$d['device_id'], $d['hour']]);
        }
        return count($dirty);
    }

    public function recompute(int $deviceId, string $hour): void
    {
        $rows = $this->db->all(
            'SELECT rtt_ms FROM ping_results WHERE device_id = ? AND ts >= ? AND ts < ? + INTERVAL 1 HOUR',
            [$deviceId, $hour, $hour],
        );
        $sent = count($rows);
        if ($sent === 0) {
            $this->db->exec('DELETE FROM ping_hourly WHERE device_id = ? AND hour = ?', [$deviceId, $hour]);
            return;
        }
        $rtts = [];
        foreach ($rows as $r) {
            if ($r['rtt_ms'] !== null) {
                $rtts[] = (float) $r['rtt_ms'];
            }
        }
        $received = count($rtts);
        $min = $avg = $max = $p95 = null;
        if ($received > 0) {
            sort($rtts);
            $min = $rtts[0];
            $max = $rtts[$received - 1];
            $avg = round(array_sum($rtts) / $received, 2);
            $p95 = $rtts[max(0, (int) ceil(0.95 * $received) - 1)];
        }
        $this->db->exec(
            'INSERT INTO ping_hourly (device_id, hour, sent, received, rtt_min, rtt_avg, rtt_max, rtt_p95)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE sent = VALUES(sent), received = VALUES(received), rtt_min = VALUES(rtt_min),
                 rtt_avg = VALUES(rtt_avg), rtt_max = VALUES(rtt_max), rtt_p95 = VALUES(rtt_p95)',
            [$deviceId, $hour, $sent, $received, $min, $avg, $max, $p95],
        );
    }

    /**
     * Deletes raw rows past raw retention and hourly rows past hourly
     * retention, in bounded batches so one cron run never locks for long.
     *
     * @return int rows deleted
     */
    public function prune(int $batch = 5000): int
    {
        $rawCutoff = Clock::toDb(Clock::now() - $this->settings->rawRetentionDays() * 86400);
        $hourlyCutoff = Clock::toDb(Clock::now() - $this->settings->hourlyRetentionDays() * 86400);
        $n = $this->db->exec("DELETE FROM ping_results WHERE ts < ? ORDER BY ts LIMIT $batch", [$rawCutoff]);
        $n += $this->db->exec("DELETE FROM ping_hourly WHERE hour < ? ORDER BY hour LIMIT $batch", [$hourlyCutoff]);
        $n += $this->db->exec('DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP()');
        $n += $this->db->exec('DELETE FROM login_attempts WHERE window_start < UTC_TIMESTAMP() - INTERVAL 1 HOUR');
        $n += $this->db->exec('DELETE FROM cron_runs WHERE started_at < UTC_TIMESTAMP() - INTERVAL 7 DAY');
        return $n;
    }
}

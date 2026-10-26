#!/usr/bin/env php
<?php
declare(strict_types=1);

/**
 * The per-minute job. cPanel cron line:
 *   * * * * * php /home/<user>/monitor/bin/cron.php >> /home/<user>/monitor/storage/cron.log 2>&1
 *
 * Steps, each bounded so the whole run fits inside one minute:
 *   1. ping every enabled website-source device that is due (parallel)
 *   2. feed the results through the status engine
 *   3. mark devices whose source has gone silent as unknown
 *   4. recompute dirty hourly rollups
 *   5. prune raw and hourly rows past retention
 * A lock file prevents overlapping runs; a cron_runs row records the outcome.
 */
require __DIR__ . '/../vendor/autoload.php';

use Monitor\App;
use Monitor\Clock;
use Monitor\Ping\WebPinger;
use Monitor\Rollup;
use Monitor\Status\StatusEngine;

$app = App::fromConfigFile(getenv('MONITOR_CONFIG') ?: __DIR__ . '/../config.php');
$budget = (int) ($app->config['cron_budget_s'] ?? 40);
$lockPath = (string) ($app->config['lock_file'] ?? __DIR__ . '/../storage/cron.lock');

@mkdir(dirname($lockPath), 0750, true);
$lock = fopen($lockPath, 'c');
if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) {
    fwrite(STDERR, "cron: previous run still holds the lock, skipping\n");
    exit(0);
}

$started = microtime(true);
$db = $app->db;
$db->exec('INSERT INTO cron_runs (started_at) VALUES (?)', [Clock::dbNow()]);
$runId = $db->lastId();
$pinged = $rolled = $pruned = 0;
$error = null;

try {
    // 1 + 2: website pings. A device is due when its last sample is older than
    // its interval minus a little slack (cron jitter), or it has none.
    $due = $db->all(
        "SELECT d.id, d.host, d.tcp_fallback_port
           FROM devices d LEFT JOIN device_status s ON s.device_id = d.id
          WHERE d.enabled = 1 AND d.source = 'web'
            AND (s.last_ts IS NULL OR s.last_ts <= UTC_TIMESTAMP() - INTERVAL (d.interval_s - 5) SECOND)",
    );
    if ($due !== []) {
        $pinger = new WebPinger($app->settings, (string) ($app->config['web_ping_method'] ?? 'auto'));
        $results = $pinger->run(array_map(fn ($d) => [
            'id' => (int) $d['id'], 'host' => (string) $d['host'],
            'tcp_fallback_port' => $d['tcp_fallback_port'] === null ? null : (int) $d['tcp_fallback_port'],
        ], $due));
        $engine = new StatusEngine($db, $app->settings);
        foreach ($results as $deviceId => $r) {
            $engine->ingest($deviceId, [$r], 'website');
            $pinged++;
        }
    }

    // 3: silence detection.
    (new StatusEngine($db, $app->settings))->markStale();

    // 4 + 5: rollups and pruning, only while there is budget left.
    $rollup = new Rollup($db, $app->settings);
    if (microtime(true) - $started < $budget * 0.6) {
        $rolled = $rollup->run();
    }
    if (microtime(true) - $started < $budget * 0.8) {
        $pruned = $rollup->prune();
    }
} catch (\Throwable $e) {
    $error = get_class($e) . ': ' . $e->getMessage();
    fwrite(STDERR, "cron: $error\n");
} finally {
    $ms = (int) round((microtime(true) - $started) * 1000);
    $db->exec(
        'UPDATE cron_runs SET finished_at = ?, duration_ms = ?, pinged = ?, rolled_up = ?, pruned = ?, error = ? WHERE id = ?',
        [Clock::dbNow(), $ms, $pinged, $rolled, $pruned, $error, $runId],
    );
    flock($lock, LOCK_UN);
    fclose($lock);
}
exit($error === null ? 0 : 1);

#!/usr/bin/env php
<?php
declare(strict_types=1);

/**
 * Nightly database backup. cPanel cron line:
 *   15 3 * * * php /home/<user>/monitor/bin/backup.php >> /home/<user>/monitor/storage/backup.log 2>&1
 *
 * Writes storage/backups/monitor-YYYYMMDD-HHMMSS.sql.gz (UTC) and keeps the
 * newest 14. Change the directory, count or mysqldump path under 'backup' in
 * config.php. Restoring is described in docs/DEPLOY.md.
 */
require __DIR__ . '/../vendor/autoload.php';

use Monitor\Backup;

$configPath = getenv('MONITOR_CONFIG') ?: __DIR__ . '/../config.php';
if (!is_file($configPath)) {
    fwrite(STDERR, "backup: config file not found: $configPath\n");
    exit(1);
}
$config = require $configPath;
$opts = (array) ($config['backup'] ?? []);

try {
    $backup = new Backup(
        (array) ($config['db'] ?? []),
        (string) ($opts['dir'] ?? __DIR__ . '/../storage/backups'),
        (int) ($opts['keep'] ?? 14),
        (string) ($opts['mysqldump'] ?? 'mysqldump'),
    );
    $file = $backup->run();
    printf("%s backup: wrote %s (%s KB), %d kept\n", gmdate('Y-m-d\TH:i:s\Z'), $file, number_format(filesize($file) / 1024), count($backup->files()));
} catch (\Throwable $e) {
    fwrite(STDERR, gmdate('Y-m-d\TH:i:s\Z') . ' backup: FAILED: ' . $e->getMessage() . "\n");
    exit(1);
}

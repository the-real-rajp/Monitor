#!/usr/bin/env php
<?php
declare(strict_types=1);
// Applies pending migrations. Run after every deploy:
//   php bin/migrate.php
require __DIR__ . '/../vendor/autoload.php';

$app = Monitor\App::fromConfigFile(getenv('MONITOR_CONFIG') ?: __DIR__ . '/../config.php');
$done = (new Monitor\Migrator($app->db, __DIR__ . '/../migrations'))->run();
echo $done === [] ? "schema is up to date\n" : 'applied: ' . implode(', ', $done) . "\n";

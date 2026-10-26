<?php
// Configuration used by the docker-compose development stack.
return [
    'db' => ['dsn' => 'mysql:host=mariadb;dbname=monitor_dev;charset=utf8mb4', 'user' => 'monitor', 'password' => 'monitor'],
    'base_url' => 'http://localhost:8000',
    'timezone' => 'UTC',
    'session_ttl' => 30 * 24 * 3600,
    'web_ping_method' => 'auto',
    'cron_budget_s' => 40,
    'lock_file' => '/tmp/monitor-cron.lock',
];

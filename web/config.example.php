<?php
// Copy to config.php (kept OUTSIDE the document root and out of git) and edit.
// On Bluehost the database name and user are prefixed with your cPanel
// username, e.g. "cpuser_monitor".
return [
    'db' => [
        'dsn'      => 'mysql:host=localhost;dbname=cpuser_monitor;charset=utf8mb4',
        'user'     => 'cpuser_monitor',
        'password' => 'change-me',
    ],

    // The URL users open, without a trailing slash. Drives the Secure flag on
    // cookies (https) and the CSRF origin check.
    'base_url' => 'https://monitor.example.com',

    // IANA time zone used for day boundaries in the 30-day strip and in emails.
    'timezone' => 'America/New_York',

    // Login lifetime in seconds, sliding. 30 days.
    'session_ttl' => 30 * 24 * 3600,

    // Website-side pinger. 'auto' tries ICMP via the ping binary once, stores
    // the result in settings, and uses TCP fallback where it is unavailable.
    // Force 'icmp' or 'tcp' to skip detection.
    'web_ping_method' => 'auto',

    // Hard ceiling for one cron run, seconds. cPanel cron fires every minute;
    // the run refuses to start if the previous one still holds the lock.
    'cron_budget_s' => 40,

    // Path for the cron lock file. Must be writable by the cron user.
    'lock_file' => __DIR__ . '/storage/cron.lock',
];

-- Monitor schema, version 1. MySQL 8 / MariaDB 10.6+, InnoDB, utf8mb4.
-- Applied by bin/migrate.php, which splits on ";\n" and records the version.

CREATE TABLE IF NOT EXISTS users (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    email         VARCHAR(190) NOT NULL,
    name          VARCHAR(100) NOT NULL,
    role          ENUM('admin','viewer') NOT NULL DEFAULT 'viewer',
    password_hash VARCHAR(255) NOT NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    disabled_at   DATETIME NULL,
    UNIQUE KEY users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
    token_hash   BINARY(32) NOT NULL PRIMARY KEY,
    user_id      INT UNSIGNED NOT NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at   DATETIME NOT NULL,
    last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    user_agent   VARCHAR(255) NOT NULL DEFAULT '',
    KEY sessions_user (user_id),
    KEY sessions_expires (expires_at),
    CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- On-prem proxies. The key is shown once; only its hash is stored.
CREATE TABLE IF NOT EXISTS agents (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name         VARCHAR(100) NOT NULL,
    key_prefix   CHAR(12) NOT NULL,
    key_hash     BINARY(32) NOT NULL,
    version      VARCHAR(40) NOT NULL DEFAULT '',
    last_seen_at DATETIME NULL,
    last_ip      VARCHAR(45) NOT NULL DEFAULT '',
    queue_depth  INT UNSIGNED NOT NULL DEFAULT 0,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at   DATETIME NULL,
    UNIQUE KEY agents_prefix (key_prefix)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS device_groups (
    id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name       VARCHAR(100) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- source 'agent': pinged by the agent in agent_id. source 'web': pinged by
-- the website cron, using ICMP when available, else TCP to tcp_fallback_port.
CREATE TABLE IF NOT EXISTS devices (
    id                INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name              VARCHAR(100) NOT NULL,
    host              VARCHAR(253) NOT NULL,
    group_id          INT UNSIGNED NULL,
    source            ENUM('agent','web') NOT NULL,
    agent_id          INT UNSIGNED NULL,
    interval_s        SMALLINT UNSIGNED NOT NULL DEFAULT 60,
    tcp_fallback_port SMALLINT UNSIGNED NULL,
    enabled           TINYINT(1) NOT NULL DEFAULT 1,
    sort_order        INT NOT NULL DEFAULT 0,
    notes             TEXT NULL,
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY devices_group (group_id),
    KEY devices_agent (agent_id, enabled),
    CONSTRAINT devices_group_fk FOREIGN KEY (group_id) REFERENCES device_groups(id) ON DELETE SET NULL,
    CONSTRAINT devices_agent_fk FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Raw samples. rtt_ms NULL means timeout. Kept 7 days (see cron prune).
CREATE TABLE IF NOT EXISTS ping_results (
    device_id INT UNSIGNED NOT NULL,
    ts        DATETIME NOT NULL,
    rtt_ms    DECIMAL(8,2) NULL,
    method    ENUM('icmp','tcp') NOT NULL DEFAULT 'icmp',
    PRIMARY KEY (device_id, ts),
    KEY ping_results_ts (ts),
    CONSTRAINT ping_results_device_fk FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Hourly rollup, the source of every chart over 24h. Kept 400 days.
CREATE TABLE IF NOT EXISTS ping_hourly (
    device_id INT UNSIGNED NOT NULL,
    hour      DATETIME NOT NULL,
    sent      INT UNSIGNED NOT NULL,
    received  INT UNSIGNED NOT NULL,
    rtt_min   DECIMAL(8,2) NULL,
    rtt_avg   DECIMAL(8,2) NULL,
    rtt_max   DECIMAL(8,2) NULL,
    rtt_p95   DECIMAL(8,2) NULL,
    PRIMARY KEY (device_id, hour),
    KEY ping_hourly_hour (hour),
    CONSTRAINT ping_hourly_device_fk FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Current state per device, maintained by the status engine on every ingest.
CREATE TABLE IF NOT EXISTS device_status (
    device_id            INT UNSIGNED NOT NULL PRIMARY KEY,
    state                ENUM('up','down','unknown') NOT NULL DEFAULT 'unknown',
    since                DATETIME NULL,
    consecutive_failures SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    streak_start         DATETIME NULL,
    last_ts              DATETIME NULL,
    last_rtt_ms          DECIMAL(8,2) NULL,
    last_method          ENUM('icmp','tcp') NULL,
    CONSTRAINT device_status_device_fk FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Outage log. A 'down' row gets ended_at and duration_s filled when the
-- device recovers.
CREATE TABLE IF NOT EXISTS events (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    device_id   INT UNSIGNED NOT NULL,
    started_at  DATETIME NOT NULL,
    ended_at    DATETIME NULL,
    duration_s  INT UNSIGNED NULL,
    detected_by VARCHAR(60) NOT NULL DEFAULT '',
    KEY events_device_started (device_id, started_at),
    KEY events_open (device_id, ended_at),
    CONSTRAINT events_device_fk FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Hours touched by ingest since the last rollup. Cron recomputes exactly these.
CREATE TABLE IF NOT EXISTS rollup_dirty (
    device_id INT UNSIGNED NOT NULL,
    hour      DATETIME NOT NULL,
    PRIMARY KEY (device_id, hour)
) ENGINE=InnoDB;

-- Fixed-window login throttling, keyed by ip or email.
CREATE TABLE IF NOT EXISTS login_attempts (
    `key`        VARCHAR(190) NOT NULL PRIMARY KEY,
    count        INT UNSIGNED NOT NULL DEFAULT 0,
    window_start DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per cron run, for the health endpoint and for tuning the budget.
CREATE TABLE IF NOT EXISTS cron_runs (
    id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    started_at  DATETIME NOT NULL,
    finished_at DATETIME NULL,
    duration_ms INT UNSIGNED NULL,
    pinged      INT UNSIGNED NOT NULL DEFAULT 0,
    rolled_up   INT UNSIGNED NOT NULL DEFAULT 0,
    pruned      INT UNSIGNED NOT NULL DEFAULT 0,
    error       TEXT NULL,
    KEY cron_runs_started (started_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS settings (
    `key`      VARCHAR(60) NOT NULL PRIMARY KEY,
    `value`    TEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO settings (`key`, `value`) VALUES
    ('down_threshold', '3'),
    ('raw_retention_days', '7'),
    ('hourly_retention_days', '400'),
    ('web_ping_method', 'unknown');

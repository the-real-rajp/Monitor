<?php
declare(strict_types=1);

namespace Monitor\Auth;

use Monitor\Db;

/**
 * Fixed-window counter in the database, so the limit holds across PHP
 * processes on shared hosting. Keyed by ip and by email so neither a single
 * attacker nor a distributed one can guess passwords quickly.
 */
final class LoginThrottle
{
    public function __construct(
        private readonly Db $db,
        private readonly int $limit = 10,
        private readonly int $windowS = 60,
    ) {
    }

    /** Records a hit and reports whether it is within the limit. */
    public function allow(string $key): bool
    {
        $key = mb_substr($key, 0, 190);
        $this->db->exec(
            'INSERT INTO login_attempts (`key`, count, window_start) VALUES (?, 1, UTC_TIMESTAMP())
             ON DUPLICATE KEY UPDATE
               count = IF(window_start < UTC_TIMESTAMP() - INTERVAL ? SECOND, 1, count + 1),
               window_start = IF(window_start < UTC_TIMESTAMP() - INTERVAL ? SECOND, UTC_TIMESTAMP(), window_start)',
            [$key, $this->windowS, $this->windowS],
        );
        $count = (int) $this->db->value('SELECT count FROM login_attempts WHERE `key` = ?', [$key]);
        return $count <= $this->limit;
    }
}

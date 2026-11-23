<?php
declare(strict_types=1);

namespace Monitor;

/**
 * Time helpers. The database stores UTC DATETIMEs as 'Y-m-d H:i:s'; the API
 * speaks RFC 3339 in UTC; the dashboard converts for display.
 */
final class Clock
{
    /** @var callable():int|null overridden in tests */
    public static mixed $now = null;

    public static function now(): int
    {
        return self::$now ? (self::$now)() : time();
    }

    /** Current time as a MySQL UTC DATETIME string. */
    public static function dbNow(): string
    {
        return gmdate('Y-m-d H:i:s', self::now());
    }

    public static function toDb(int $ts): string
    {
        return gmdate('Y-m-d H:i:s', $ts);
    }

    /** Parses a MySQL UTC DATETIME string to a unix timestamp. */
    public static function fromDb(string $dt): int
    {
        return (int) strtotime($dt . ' UTC');
    }

    /** MySQL DATETIME (UTC) to RFC 3339 for the API. Null passes through. */
    public static function iso(?string $dt): ?string
    {
        return $dt === null ? null : gmdate('Y-m-d\TH:i:s\Z', self::fromDb($dt));
    }

    /**
     * Parses an RFC 3339 or unix-seconds timestamp from an agent into a
     * MySQL UTC DATETIME, or null when unparseable.
     */
    public static function parseIncoming(mixed $v): ?string
    {
        if (is_int($v) || (is_float($v) && $v == floor($v))) {
            $ts = (int) $v;
        } elseif (is_string($v) && $v !== '') {
            $ts = strtotime($v);
            if ($ts === false) {
                return null;
            }
        } else {
            return null;
        }
        // Reject anything more than 10 minutes in the future (clock skew) or
        // older than 30 days (nothing useful can be backfilled that far).
        $now = self::now();
        if ($ts > $now + 600 || $ts < $now - 30 * 86400) {
            return null;
        }
        return gmdate('Y-m-d H:i:s', $ts);
    }
}

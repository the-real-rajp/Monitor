<?php
declare(strict_types=1);

namespace Monitor;

/** Key-value settings stored in the database, read once per request. */
final class Settings
{
    /** @var array<string,string>|null */
    private ?array $cache = null;

    public function __construct(private readonly Db $db)
    {
    }

    public function get(string $key, string $default = ''): string
    {
        if ($this->cache === null) {
            $this->cache = [];
            foreach ($this->db->all('SELECT `key`, `value` FROM settings') as $row) {
                $this->cache[(string) $row['key']] = (string) $row['value'];
            }
        }
        return $this->cache[$key] ?? $default;
    }

    public function set(string $key, string $value): void
    {
        $this->db->exec(
            'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
            [$key, $value],
        );
        if ($this->cache !== null) {
            $this->cache[$key] = $value;
        }
    }

    /** Dashboard auto-refresh choices in seconds; 0 turns it off. */
    public const REFRESH_CHOICES = [0, 10, 30, 60, 300];

    /** The auto-refresh interval browsers use until a person picks their own. */
    public function refreshDefaultSeconds(): int
    {
        $s = (int) $this->get('refresh_default_s', '10');
        return in_array($s, self::REFRESH_CHOICES, true) ? $s : 10;
    }

    public function downThreshold(): int
    {
        return max(1, (int) $this->get('down_threshold', '3'));
    }

    public function rawRetentionDays(): int
    {
        return max(1, (int) $this->get('raw_retention_days', '7'));
    }

    public function hourlyRetentionDays(): int
    {
        return max(31, (int) $this->get('hourly_retention_days', '400'));
    }
}

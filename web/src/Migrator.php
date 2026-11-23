<?php
declare(strict_types=1);

namespace Monitor;

/**
 * Applies migrations/NNN_name.sql in order, once each. Forward-only. Files
 * are split into statements on ";\n" so each can be executed separately,
 * which MySQL's PDO driver requires without emulated prepares.
 */
final class Migrator
{
    public function __construct(private readonly Db $db, private readonly string $dir)
    {
    }

    /** @return list<string> names of migrations applied in this run */
    public function run(): array
    {
        $this->db->exec('CREATE TABLE IF NOT EXISTS schema_migrations (
            version    INT UNSIGNED NOT NULL PRIMARY KEY,
            name       VARCHAR(100) NOT NULL,
            applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB');
        $applied = array_map('intval', array_column($this->db->all('SELECT version FROM schema_migrations'), 'version'));

        $files = glob($this->dir . '/*.sql') ?: [];
        sort($files);
        $done = [];
        foreach ($files as $file) {
            if (!preg_match('/^(\d{3})_([a-z0-9_]+)\.sql$/', basename($file), $m)) {
                throw new \RuntimeException("migration file name not NNN_name.sql: $file");
            }
            $version = (int) $m[1];
            if (in_array($version, $applied, true)) {
                continue;
            }
            $sql = file_get_contents($file);
            if ($sql === false) {
                throw new \RuntimeException("cannot read $file");
            }
            foreach (self::statements($sql) as $stmt) {
                $this->db->pdo->exec($stmt);
            }
            $this->db->exec('INSERT INTO schema_migrations (version, name) VALUES (?, ?)', [$version, $m[2]]);
            $done[] = basename($file);
        }
        return $done;
    }

    /** @return list<string> */
    public static function statements(string $sql): array
    {
        // Strip full-line comments, then split on statement terminators.
        $lines = array_filter(explode("\n", $sql), fn ($l) => !str_starts_with(ltrim($l), '--'));
        $out = [];
        foreach (explode(";\n", implode("\n", $lines) . "\n") as $chunk) {
            $chunk = trim($chunk);
            if ($chunk !== '') {
                $out[] = $chunk;
            }
        }
        return $out;
    }
}

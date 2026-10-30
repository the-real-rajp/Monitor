<?php
declare(strict_types=1);

namespace Monitor;

/** Thin PDO wrapper: prepared statements everywhere, exceptions on error. */
final class Db
{
    public function __construct(public readonly \PDO $pdo)
    {
    }

    /** @param array{dsn:string,user:string,password:string} $cfg */
    public static function connect(array $cfg): self
    {
        $pdo = new \PDO($cfg['dsn'], $cfg['user'], $cfg['password'], [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
            \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
            \PDO::ATTR_EMULATE_PREPARES => false,
            \PDO::ATTR_STRINGIFY_FETCHES => false,
        ]);
        // All timestamps are stored and compared in UTC; the app converts
        // for display using the configured time zone.
        $pdo->exec("SET time_zone = '+00:00'");
        return new self($pdo);
    }

    /** @param list<mixed>|array<string,mixed> $params */
    public function run(string $sql, array $params = []): \PDOStatement
    {
        $st = $this->pdo->prepare($sql);
        $st->execute($params);
        return $st;
    }

    /** @param list<mixed>|array<string,mixed> $params */
    public function exec(string $sql, array $params = []): int
    {
        return $this->run($sql, $params)->rowCount();
    }

    /**
     * @param list<mixed>|array<string,mixed> $params
     * @return array<string,mixed>|null
     */
    public function one(string $sql, array $params = []): ?array
    {
        $row = $this->run($sql, $params)->fetch();
        return $row === false ? null : $row;
    }

    /**
     * @param list<mixed>|array<string,mixed> $params
     * @return list<array<string,mixed>>
     */
    public function all(string $sql, array $params = []): array
    {
        return $this->run($sql, $params)->fetchAll();
    }

    /** @param list<mixed>|array<string,mixed> $params */
    public function value(string $sql, array $params = []): mixed
    {
        $v = $this->run($sql, $params)->fetchColumn();
        return $v === false ? null : $v;
    }

    public function lastId(): int
    {
        return (int) $this->pdo->lastInsertId();
    }

    /**
     * @template T
     * @param callable(self):T $fn
     * @return T
     */
    public function transaction(callable $fn): mixed
    {
        $this->pdo->beginTransaction();
        try {
            $out = $fn($this);
            $this->pdo->commit();
            return $out;
        } catch (\Throwable $e) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            throw $e;
        }
    }

    /** MySQL error 1062, duplicate key. */
    public static function isDuplicate(\PDOException $e): bool
    {
        return ($e->errorInfo[1] ?? null) === 1062;
    }
}

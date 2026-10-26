<?php
declare(strict_types=1);

namespace Monitor;

use Monitor\Http\HttpError;

final class Users
{
    public const MIN_PASSWORD = 12;

    public function __construct(private readonly Db $db)
    {
    }

    public static function normalizeEmail(string $email): string
    {
        $email = mb_strtolower(trim($email));
        if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL) || mb_strlen($email) > 190) {
            throw HttpError::badRequest('email is not a valid address');
        }
        return $email;
    }

    public static function validatePassword(string $password): void
    {
        if (mb_strlen($password) < self::MIN_PASSWORD) {
            throw HttpError::badRequest('password must be at least ' . self::MIN_PASSWORD . ' characters');
        }
        if (strlen($password) > 1024) {
            throw HttpError::badRequest('password is too long');
        }
    }

    public function create(string $email, string $name, string $role, string $password): int
    {
        $email = self::normalizeEmail($email);
        $name = trim($name);
        if ($name === '' || mb_strlen($name) > 100) {
            throw HttpError::badRequest('name is required and at most 100 characters');
        }
        if (!in_array($role, ['admin', 'viewer'], true)) {
            throw HttpError::badRequest('role must be admin or viewer');
        }
        self::validatePassword($password);
        try {
            $this->db->exec(
                'INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)',
                [$email, $name, $role, password_hash($password, PASSWORD_ARGON2ID)],
            );
        } catch (\PDOException $e) {
            if (Db::isDuplicate($e)) {
                throw HttpError::conflict('a user with that email already exists');
            }
            throw $e;
        }
        return $this->db->lastId();
    }

    /** @return array<string,mixed>|null */
    public function byEmail(string $email): ?array
    {
        return $this->db->one('SELECT * FROM users WHERE email = ?', [mb_strtolower(trim($email))]);
    }

    /** @return array<string,mixed>|null */
    public function byId(int $id): ?array
    {
        return $this->db->one('SELECT * FROM users WHERE id = ?', [$id]);
    }

    /** @return list<array<string,mixed>> */
    public function all(): array
    {
        return $this->db->all('SELECT * FROM users ORDER BY created_at, id');
    }

    public function verify(string $email, string $password): ?array
    {
        $u = $this->byEmail($email);
        // Always run a hash check so timing does not reveal whether the email exists.
        $hash = $u['password_hash'] ?? self::dummyHash();
        $ok = password_verify($password, $hash);
        if ($u === null || !$ok || $u['disabled_at'] !== null) {
            return null;
        }
        return $u;
    }

    /** Sets a new password and revokes every session of the user. */
    public function setPassword(int $id, string $password): void
    {
        self::validatePassword($password);
        $this->db->transaction(function (Db $db) use ($id, $password) {
            $db->exec('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash($password, PASSWORD_ARGON2ID), $id]);
            $db->exec('DELETE FROM sessions WHERE user_id = ?', [$id]);
        });
    }

    /** @param array<string,mixed> $u */
    public static function toApi(array $u): array
    {
        return [
            'id'         => (int) $u['id'],
            'email'      => $u['email'],
            'name'       => $u['name'],
            'role'       => $u['role'],
            'disabled'   => $u['disabled_at'] !== null,
            'created_at' => Clock::iso($u['created_at']),
        ];
    }

    private static function dummyHash(): string
    {
        static $h = null;
        return $h ??= password_hash('not-a-real-password-for-timing-only', PASSWORD_ARGON2ID);
    }
}

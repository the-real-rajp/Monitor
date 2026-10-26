<?php
declare(strict_types=1);

namespace Monitor\Auth;

use Monitor\Db;

/**
 * Browser sessions. The cookie carries a random token; only its SHA-256 is
 * stored. Expiry slides forward on use.
 */
final class Sessions
{
    public const COOKIE = 'monitor_session';

    public function __construct(private readonly Db $db, private readonly int $ttl)
    {
    }

    /** Creates a session and returns the raw token for the cookie. */
    public function create(int $userId, string $userAgent): string
    {
        $token = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
        $this->db->exec(
            'INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)',
            [hash('sha256', $token, true), $userId, $this->expiry(), mb_substr($userAgent, 0, 255)],
        );
        return $token;
    }

    /**
     * Returns the user row for a live session, or null. Touches the session
     * at most once a minute to avoid a write on every request.
     *
     * @return array<string,mixed>|null
     */
    public function user(string $token): ?array
    {
        $hash = hash('sha256', $token, true);
        $row = $this->db->one(
            'SELECT u.*, s.expires_at, s.last_seen_at FROM sessions s
               JOIN users u ON u.id = s.user_id
              WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP() AND u.disabled_at IS NULL',
            [$hash],
        );
        if ($row === null) {
            return null;
        }
        if (strtotime((string) $row['last_seen_at'] . ' UTC') < time() - 60) {
            $this->db->exec(
                'UPDATE sessions SET last_seen_at = UTC_TIMESTAMP(), expires_at = ? WHERE token_hash = ?',
                [$this->expiry(), $hash],
            );
        }
        unset($row['expires_at'], $row['last_seen_at']);
        return $row;
    }

    public function delete(string $token): void
    {
        $this->db->exec('DELETE FROM sessions WHERE token_hash = ?', [hash('sha256', $token, true)]);
    }

    public function deleteForUser(int $userId): void
    {
        $this->db->exec('DELETE FROM sessions WHERE user_id = ?', [$userId]);
    }

    public function deleteExpired(): int
    {
        return $this->db->exec('DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP()');
    }

    /** @return array<string,mixed> setcookie() options */
    public function cookieOptions(bool $secure, bool $clear = false): array
    {
        return [
            'expires'  => $clear ? 1 : time() + $this->ttl,
            'path'     => '/',
            'secure'   => $secure,
            'httponly' => true,
            'samesite' => 'Lax',
        ];
    }

    private function expiry(): string
    {
        return gmdate('Y-m-d H:i:s', time() + $this->ttl);
    }
}

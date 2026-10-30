<?php
declare(strict_types=1);

namespace Monitor\Auth;

/**
 * Agent API keys: mon_<12 hex prefix>_<64 hex secret>. The prefix finds the
 * row; the SHA-256 of the whole key is compared in constant time. Only the
 * hash is stored, so a database leak yields no usable keys.
 */
final class AgentKeys
{
    private const PREFIX_LEN = 12;
    private const SECRET_LEN = 64;

    /** @return array{key:string,prefix:string,hash:string} */
    public static function generate(): array
    {
        $prefix = bin2hex(random_bytes(self::PREFIX_LEN / 2));
        $secret = bin2hex(random_bytes(self::SECRET_LEN / 2));
        $key = "mon_{$prefix}_{$secret}";
        return ['key' => $key, 'prefix' => $prefix, 'hash' => self::hash($key)];
    }

    /** Returns the prefix of a well-formed key, or null. */
    public static function prefix(string $key): ?string
    {
        if (!preg_match('/^mon_([0-9a-f]{12})_[0-9a-f]{64}$/', $key, $m)) {
            return null;
        }
        return $m[1];
    }

    public static function hash(string $key): string
    {
        return hash('sha256', $key, true);
    }

    public static function matches(string $key, string $storedHash): bool
    {
        return hash_equals($storedHash, self::hash($key));
    }
}

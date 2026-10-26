<?php
declare(strict_types=1);

namespace Monitor\Auth;

/** The authenticated caller: a user (browser session) or an agent (API key). */
final class Principal
{
    /**
     * @param array<string,mixed>|null $user  users row
     * @param array<string,mixed>|null $agent agents row
     */
    private function __construct(
        public readonly ?array $user,
        public readonly ?array $agent,
        public readonly ?string $sessionToken,
    ) {
    }

    /** @param array<string,mixed> $user */
    public static function forUser(array $user, string $sessionToken): self
    {
        return new self($user, null, $sessionToken);
    }

    /** @param array<string,mixed> $agent */
    public static function forAgent(array $agent): self
    {
        return new self(null, $agent, null);
    }

    public function isAdmin(): bool
    {
        return $this->user !== null && $this->user['role'] === 'admin';
    }

    public function userId(): int
    {
        return (int) ($this->user['id'] ?? throw new \LogicException('not a user'));
    }

    public function agentId(): int
    {
        return (int) ($this->agent['id'] ?? throw new \LogicException('not an agent'));
    }
}

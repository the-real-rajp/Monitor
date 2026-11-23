<?php
declare(strict_types=1);

namespace Monitor\Http;

/**
 * An error that maps directly to an HTTP response. Handlers throw these;
 * App converts them to the JSON error shape {"error": {"code", "message"}}.
 */
final class HttpError extends \RuntimeException
{
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
    ) {
        parent::__construct($message);
    }

    public static function badRequest(string $message): self
    {
        return new self(400, 'bad_request', $message);
    }

    public static function unauthorized(string $message = 'authentication required'): self
    {
        return new self(401, 'unauthorized', $message);
    }

    public static function forbidden(string $message = 'not allowed'): self
    {
        return new self(403, 'forbidden', $message);
    }

    public static function notFound(string $message = 'not found'): self
    {
        return new self(404, 'not_found', $message);
    }

    public static function conflict(string $message): self
    {
        return new self(409, 'conflict', $message);
    }

    public static function rateLimited(string $message = 'too many requests'): self
    {
        return new self(429, 'rate_limited', $message);
    }
}

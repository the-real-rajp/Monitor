<?php
declare(strict_types=1);

namespace Monitor\Http;

/** A parsed HTTP request. Built from PHP globals in production, by hand in tests. */
final class Request
{
    /** @var array<string,string> */
    public array $params = [];

    /** Set by App after authentication; null for anonymous requests. */
    public ?\Monitor\Auth\Principal $principal = null;

    /** @var array<string,mixed>|null */
    private ?array $json = null;
    private bool $jsonParsed = false;

    /**
     * @param array<string,string> $query
     * @param array<string,string> $headers lower-case names
     * @param array<string,string> $cookies
     */
    public function __construct(
        public readonly string $method,
        public readonly string $path,
        public readonly array $query,
        public readonly array $headers,
        public readonly array $cookies,
        public readonly string $body,
        public readonly string $ip,
    ) {
    }

    public static function fromGlobals(): self
    {
        $uri = $_SERVER['REQUEST_URI'] ?? '/';
        $path = parse_url($uri, PHP_URL_PATH) ?: '/';
        $headers = [];
        foreach ($_SERVER as $k => $v) {
            if (str_starts_with($k, 'HTTP_')) {
                $headers[strtolower(str_replace('_', '-', substr($k, 5)))] = (string) $v;
            }
        }
        foreach (['CONTENT_TYPE' => 'content-type', 'CONTENT_LENGTH' => 'content-length'] as $k => $name) {
            if (isset($_SERVER[$k])) {
                $headers[$name] = (string) $_SERVER[$k];
            }
        }
        $body = file_get_contents('php://input') ?: '';
        return new self(
            strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET'),
            rtrim($path, '/') ?: '/',
            array_map('strval', $_GET),
            $headers,
            array_map('strval', $_COOKIE),
            $body,
            (string) ($_SERVER['REMOTE_ADDR'] ?? ''),
        );
    }

    public function header(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }

    public function cookie(string $name): ?string
    {
        return $this->cookies[$name] ?? null;
    }

    public function query(string $name, ?string $default = null): ?string
    {
        return $this->query[$name] ?? $default;
    }

    public function param(string $name): string
    {
        return $this->params[$name] ?? throw new \LogicException("missing route param $name");
    }

    /** Route param that must be a positive integer id. */
    public function intParam(string $name): int
    {
        $v = $this->param($name);
        if (!ctype_digit($v) || $v === '0' || strlen($v) > 10) {
            throw HttpError::notFound();
        }
        return (int) $v;
    }

    /**
     * The JSON object body. Rejects non-objects, bodies over 1 MiB and
     * fields outside $allowed when given, so typos surface as 400s.
     *
     * @param list<string>|null $allowed
     * @return array<string,mixed>
     */
    public function json(?array $allowed = null): array
    {
        if (!$this->jsonParsed) {
            $this->jsonParsed = true;
            if (strlen($this->body) > 1 << 20) {
                throw HttpError::badRequest('request body too large');
            }
            if (trim($this->body) === '') {
                throw HttpError::badRequest('request body must be a JSON object');
            }
            try {
                $decoded = json_decode($this->body, true, 64, JSON_THROW_ON_ERROR);
            } catch (\JsonException $e) {
                throw HttpError::badRequest('invalid JSON body: ' . $e->getMessage());
            }
            if (!is_array($decoded) || array_is_list($decoded) && $decoded !== []) {
                throw HttpError::badRequest('request body must be a JSON object');
            }
            $this->json = $decoded;
        }
        $data = $this->json ?? [];
        if ($allowed !== null) {
            $unknown = array_diff(array_keys($data), $allowed);
            if ($unknown !== []) {
                throw HttpError::badRequest('unknown field: ' . implode(', ', array_map('strval', $unknown)));
            }
        }
        return $data;
    }
}

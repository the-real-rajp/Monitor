<?php
declare(strict_types=1);

namespace Monitor\Http;

final class Response
{
    /** @var array<string,string> */
    private array $headers = [];
    /** @var list<array{string,string,array<string,mixed>}> */
    private array $cookies = [];

    public function __construct(
        public int $status = 200,
        public string $body = '',
    ) {
    }

    public static function json(mixed $data, int $status = 200): self
    {
        $r = new self($status, json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES));
        return $r->withHeader('Content-Type', 'application/json; charset=utf-8');
    }

    public static function noContent(): self
    {
        return new self(204);
    }

    public static function error(int $status, string $code, string $message): self
    {
        return self::json(['error' => ['code' => $code, 'message' => $message]], $status);
    }

    public static function html(string $html, int $status = 200): self
    {
        return (new self($status, $html))->withHeader('Content-Type', 'text/html; charset=utf-8');
    }

    public function withHeader(string $name, string $value): self
    {
        $this->headers[$name] = $value;
        return $this;
    }

    public function header(string $name): ?string
    {
        return $this->headers[$name] ?? null;
    }

    /** @param array<string,mixed> $options as for setcookie() */
    public function withCookie(string $name, string $value, array $options): self
    {
        $this->cookies[] = [$name, $value, $options];
        return $this;
    }

    /** @return list<array{string,string,array<string,mixed>}> */
    public function cookies(): array
    {
        return $this->cookies;
    }

    public function send(): void
    {
        http_response_code($this->status);
        foreach ($this->headers as $k => $v) {
            header("$k: $v");
        }
        foreach ($this->cookies as [$name, $value, $opts]) {
            setcookie($name, $value, $opts);
        }
        if ($this->status !== 204 && $this->status !== 304) {
            echo $this->body;
        }
    }
}

<?php
declare(strict_types=1);

namespace Monitor\Http;

/**
 * Who may call a route. Checked by App before the handler runs.
 */
enum Auth: string
{
    case None = 'none';       // public
    case Session = 'session'; // any logged-in user
    case Admin = 'admin';     // logged-in admin
    case Agent = 'agent';     // a proxy with a valid API key
}

final class Route
{
    /** @param callable(Request):Response $handler */
    public function __construct(
        public readonly string $method,
        public readonly string $pattern,
        public readonly mixed $handler,
        public readonly Auth $auth,
        public readonly string $regex,
    ) {
    }
}

final class Router
{
    /** @var list<Route> */
    private array $routes = [];

    /** @param callable(Request):Response $handler */
    public function add(string $method, string $pattern, callable $handler, Auth $auth): void
    {
        $regex = '#^' . preg_replace('#\{([a-zA-Z_][a-zA-Z0-9_]*)\}#', '(?P<$1>[^/]+)', $pattern) . '$#';
        $this->routes[] = new Route(strtoupper($method), $pattern, $handler, $auth, $regex);
    }

    /** @return list<Route> */
    public function routes(): array
    {
        return $this->routes;
    }

    /**
     * Finds the route for a request and fills its params. Returns null when
     * nothing matches; sets $methodMismatch when the path exists for another
     * method so the caller can answer 405.
     */
    public function match(Request $request, bool &$methodMismatch = false): ?Route
    {
        $methodMismatch = false;
        foreach ($this->routes as $route) {
            if (!preg_match($route->regex, $request->path, $m)) {
                continue;
            }
            if ($route->method !== $request->method) {
                $methodMismatch = true;
                continue;
            }
            foreach ($m as $k => $v) {
                if (is_string($k)) {
                    $request->params[$k] = $v;
                }
            }
            return $route;
        }
        return null;
    }
}

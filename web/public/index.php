<?php
declare(strict_types=1);

// Front controller. config.php lives one level above the document root.

// PHP's built-in development server routes every request here; hand real
// files (the built dashboard's assets) back to it. Apache never reaches this
// branch because .htaccess only rewrites paths that are not files.
if (PHP_SAPI === 'cli-server') {
    $file = __DIR__ . parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
    if ($file !== __DIR__ . '/' && is_file($file)) {
        return false;
    }
}

require __DIR__ . '/../vendor/autoload.php';

$configPath = getenv('MONITOR_CONFIG') ?: __DIR__ . '/../config.php';
$app = Monitor\App::fromConfigFile($configPath);
$app->handle(Monitor\Http\Request::fromGlobals())->send();

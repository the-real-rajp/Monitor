<?php
declare(strict_types=1);

namespace Monitor\Handlers;

use Monitor\App;
use Monitor\Http\HttpError;
use Monitor\Http\Request;
use Monitor\Http\Response;
use Monitor\Settings;

/** Site-wide settings an admin can change, plus read-only facts about the install. */
final class SettingsHandlers
{
    public function __construct(private readonly App $app)
    {
    }

    public function get(Request $req): Response
    {
        return Response::json($this->payload());
    }

    public function update(Request $req): Response
    {
        $in = $req->json(['down_threshold', 'raw_retention_days', 'refresh_default_s']);
        $changes = [];
        if (array_key_exists('down_threshold', $in)) {
            $changes['down_threshold'] = self::intBetween($in['down_threshold'], 1, 10, 'down_threshold');
        }
        if (array_key_exists('raw_retention_days', $in)) {
            $changes['raw_retention_days'] = self::intBetween($in['raw_retention_days'], 1, 31, 'raw_retention_days');
        }
        if (array_key_exists('refresh_default_s', $in)) {
            if (!is_int($in['refresh_default_s']) || !in_array($in['refresh_default_s'], Settings::REFRESH_CHOICES, true)) {
                throw HttpError::badRequest('refresh_default_s must be one of ' . implode(', ', Settings::REFRESH_CHOICES));
            }
            $changes['refresh_default_s'] = $in['refresh_default_s'];
        }
        foreach ($changes as $key => $value) {
            $this->app->settings->set($key, (string) $value);
        }
        return Response::json($this->payload());
    }

    /** @return array<string,mixed> */
    private function payload(): array
    {
        $s = $this->app->settings;
        $build = @file_get_contents(__DIR__ . '/../../BUILD');
        return [
            'settings' => [
                'down_threshold'     => $s->downThreshold(),
                'raw_retention_days' => $s->rawRetentionDays(),
                'refresh_default_s'  => $s->refreshDefaultSeconds(),
            ],
            // Set in config.php or detected; shown for reference only.
            'info' => [
                'version'         => HealthHandlers::VERSION,
                'build'           => $build === false ? null : substr(trim($build), 0, 12),
                'base_url'        => $this->app->baseUrl(),
                'timezone'        => $this->app->timezone()->getName(),
                'web_ping_method' => $s->get('web_ping_method', 'unknown'),
            ],
        ];
    }

    private static function intBetween(mixed $v, int $min, int $max, string $name): int
    {
        if (!is_int($v) || $v < $min || $v > $max) {
            throw HttpError::badRequest("$name must be a whole number from $min to $max");
        }
        return $v;
    }
}

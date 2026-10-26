// Package config loads server configuration from environment variables.
// Every setting has a MONITOR_ prefix so it is obvious in a process listing
// which variables belong to us.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Server is the configuration for monitor-server.
type Server struct {
	// ListenAddr is the host:port for the HTTP API and web UI.
	ListenAddr string
	// PostgresURL is a pgx connection string.
	PostgresURL string
	// ClickHouseURL is a clickhouse:// DSN.
	ClickHouseURL string
	// PublicURL is the externally visible base URL, used for cookie security
	// and CSRF origin checks. Example: https://monitor.example.com
	PublicURL string
	// SessionTTL is how long a login lasts without activity.
	SessionTTL time.Duration
	// SecureCookies forces the Secure flag on cookies. Defaults to true when
	// PublicURL is https.
	SecureCookies bool
	// MigrateOnStart applies pending migrations before serving.
	MigrateOnStart bool
	// SelfMetricsInterval is how often the server writes its own metrics.
	SelfMetricsInterval time.Duration
	// LogLevel is debug, info, warn or error.
	LogLevel string
	// LogFormat is json or text.
	LogFormat string
}

// LoadServer reads the environment. Missing optional values get defaults;
// missing required values produce one combined error.
func LoadServer() (Server, error) {
	c := Server{
		ListenAddr:          env("MONITOR_LISTEN_ADDR", ":8080"),
		PostgresURL:         env("MONITOR_POSTGRES_URL", ""),
		ClickHouseURL:       env("MONITOR_CLICKHOUSE_URL", ""),
		PublicURL:           strings.TrimRight(env("MONITOR_PUBLIC_URL", "http://localhost:8080"), "/"),
		LogLevel:            env("MONITOR_LOG_LEVEL", "info"),
		LogFormat:           env("MONITOR_LOG_FORMAT", "json"),
		SessionTTL:          envDuration("MONITOR_SESSION_TTL", 30*24*time.Hour),
		SelfMetricsInterval: envDuration("MONITOR_SELF_METRICS_INTERVAL", 15*time.Second),
		MigrateOnStart:      envBool("MONITOR_MIGRATE_ON_START", true),
	}
	c.SecureCookies = envBool("MONITOR_SECURE_COOKIES", strings.HasPrefix(c.PublicURL, "https://"))

	var errs []error
	if c.PostgresURL == "" {
		errs = append(errs, errors.New("MONITOR_POSTGRES_URL is required"))
	}
	if c.ClickHouseURL == "" {
		errs = append(errs, errors.New("MONITOR_CLICKHOUSE_URL is required"))
	}
	if !strings.HasPrefix(c.PublicURL, "http://") && !strings.HasPrefix(c.PublicURL, "https://") {
		errs = append(errs, errors.New("MONITOR_PUBLIC_URL must start with http:// or https://"))
	}
	switch c.LogFormat {
	case "json", "text":
	default:
		errs = append(errs, fmt.Errorf("MONITOR_LOG_FORMAT must be json or text, got %q", c.LogFormat))
	}
	return c, errors.Join(errs...)
}

func env(name, def string) string {
	if v, ok := os.LookupEnv(name); ok && v != "" {
		return v
	}
	return def
}

func envBool(name string, def bool) bool {
	v, ok := os.LookupEnv(name)
	if !ok || v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

func envDuration(name string, def time.Duration) time.Duration {
	v, ok := os.LookupEnv(name)
	if !ok || v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return def
	}
	return d
}

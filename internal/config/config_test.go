package config

import (
	"strings"
	"testing"
	"time"
)

func TestLoadServerDefaultsAndValidation(t *testing.T) {
	t.Setenv("MONITOR_POSTGRES_URL", "")
	t.Setenv("MONITOR_CLICKHOUSE_URL", "")
	_, err := LoadServer()
	if err == nil || !strings.Contains(err.Error(), "MONITOR_POSTGRES_URL") || !strings.Contains(err.Error(), "MONITOR_CLICKHOUSE_URL") {
		t.Fatalf("expected both required errors, got %v", err)
	}

	t.Setenv("MONITOR_POSTGRES_URL", "postgres://x")
	t.Setenv("MONITOR_CLICKHOUSE_URL", "clickhouse://y")
	t.Setenv("MONITOR_PUBLIC_URL", "https://monitor.example.com/")
	t.Setenv("MONITOR_SESSION_TTL", "1h")
	c, err := LoadServer()
	if err != nil {
		t.Fatal(err)
	}
	if c.ListenAddr != ":8080" || c.LogFormat != "json" || !c.MigrateOnStart {
		t.Errorf("defaults wrong: %+v", c)
	}
	if c.PublicURL != "https://monitor.example.com" {
		t.Errorf("trailing slash not trimmed: %q", c.PublicURL)
	}
	if !c.SecureCookies {
		t.Error("https public URL should default to secure cookies")
	}
	if c.SessionTTL != time.Hour {
		t.Errorf("session ttl %v", c.SessionTTL)
	}

	t.Setenv("MONITOR_LOG_FORMAT", "xml")
	if _, err := LoadServer(); err == nil {
		t.Error("bad log format accepted")
	}
}

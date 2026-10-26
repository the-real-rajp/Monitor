// Package testutil provides database fixtures for integration tests.
//
// Integration tests are built with -tags integration and read the databases
// to use from MONITOR_TEST_PG_URL and MONITOR_TEST_CH_URL. Each test gets a
// migrated, empty schema: a fresh PostgreSQL schema or a fresh ClickHouse
// database, dropped when the test ends.
package testutil

import (
	"context"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/url"
	"os"
	"testing"

	"github.com/the-real-rajp/monitor/internal/store/ch"
	"github.com/the-real-rajp/monitor/internal/store/pg"
)

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
}

// PG returns a migrated PostgreSQL store on a private schema, or skips the
// test when MONITOR_TEST_PG_URL is unset.
func PG(t *testing.T) *pg.DB {
	t.Helper()
	base := os.Getenv("MONITOR_TEST_PG_URL")
	if base == "" {
		t.Skip("MONITOR_TEST_PG_URL not set")
	}
	ctx := context.Background()
	schema := fmt.Sprintf("test_%08x", rand.Uint32()) //nolint:gosec // test isolation only

	admin, err := pg.Open(ctx, base)
	if err != nil {
		t.Fatalf("open postgres: %v", err)
	}
	if _, err := admin.Pool.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		_, _ = admin.Pool.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		admin.Close()
	})

	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	// pgcrypto is created in the migration; keep public on the path so the
	// extension's functions resolve.
	q.Set("search_path", schema+",public")
	u.RawQuery = q.Encode()
	db, err := pg.Open(ctx, u.String())
	if err != nil {
		t.Fatalf("open postgres schema: %v", err)
	}
	t.Cleanup(db.Close)
	if _, err := db.Migrate(ctx, quietLogger()); err != nil {
		t.Fatalf("migrate postgres: %v", err)
	}
	return db
}

// CH returns a migrated ClickHouse store on a private database, or skips
// the test when MONITOR_TEST_CH_URL is unset.
func CH(t *testing.T) *ch.DB {
	t.Helper()
	base := os.Getenv("MONITOR_TEST_CH_URL")
	if base == "" {
		t.Skip("MONITOR_TEST_CH_URL not set")
	}
	ctx := context.Background()
	name := fmt.Sprintf("test_%08x", rand.Uint32()) //nolint:gosec // test isolation only

	admin, err := ch.Open(ctx, base)
	if err != nil {
		t.Fatalf("open clickhouse: %v", err)
	}
	if err := admin.Conn.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatalf("create database: %v", err)
	}
	t.Cleanup(func() {
		_ = admin.Conn.Exec(context.Background(), "DROP DATABASE IF EXISTS "+name)
		_ = admin.Close()
	})

	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	db, err := ch.Open(ctx, u.String())
	if err != nil {
		t.Fatalf("open clickhouse database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Migrate(ctx, quietLogger()); err != nil {
		t.Fatalf("migrate clickhouse: %v", err)
	}
	return db
}

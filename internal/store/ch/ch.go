// Package ch is the ClickHouse telemetry store: check results, metrics, logs
// and spans. Phase 0 ships the metrics tables and a batched writer that the
// server uses for its own metrics.
package ch

import (
	"context"
	"embed"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/google/uuid"

	"github.com/the-real-rajp/monitor/internal/store/migrate"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// DB is a ClickHouse connection.
type DB struct {
	Conn driver.Conn
}

// Open connects using a clickhouse:// or http(s):// URL and verifies it.
func Open(ctx context.Context, url string) (*DB, error) {
	opts, err := clickhouse.ParseDSN(url)
	if err != nil {
		return nil, fmt.Errorf("parse clickhouse url: %w", err)
	}
	opts.DialTimeout = 10 * time.Second
	opts.Compression = &clickhouse.Compression{Method: clickhouse.CompressionLZ4}
	conn, err := clickhouse.Open(opts)
	if err != nil {
		return nil, fmt.Errorf("open clickhouse: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := conn.Ping(pingCtx); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("ping clickhouse: %w", err)
	}
	return &DB{Conn: conn}, nil
}

// Close closes the connection.
func (d *DB) Close() error { return d.Conn.Close() }

// Ping reports whether the database is reachable.
func (d *DB) Ping(ctx context.Context) error { return d.Conn.Ping(ctx) }

// Migrate applies pending schema migrations.
func (d *DB) Migrate(ctx context.Context, log *slog.Logger) (int, error) {
	ms, err := migrate.Load(migrationFS, "migrations")
	if err != nil {
		return 0, err
	}
	return migrate.Run(ctx, log.With("store", "clickhouse"), target{d.Conn}, ms)
}

// MetricPoint is one sample in metrics_raw.
type MetricPoint struct {
	OrgID      uuid.UUID
	Metric     string
	ResourceID string
	Labels     map[string]string
	TS         time.Time
	Value      float64
}

// InsertMetrics writes a batch of points in one block.
func (d *DB) InsertMetrics(ctx context.Context, pts []MetricPoint) error {
	if len(pts) == 0 {
		return nil
	}
	batch, err := d.Conn.PrepareBatch(ctx, `INSERT INTO metrics_raw (org_id, metric, resource_id, labels, ts, value)`)
	if err != nil {
		return fmt.Errorf("prepare batch: %w", err)
	}
	for _, p := range pts {
		labels := p.Labels
		if labels == nil {
			labels = map[string]string{}
		}
		if err := batch.Append(p.OrgID, p.Metric, p.ResourceID, labels, p.TS, p.Value); err != nil {
			return fmt.Errorf("append: %w", err)
		}
	}
	return batch.Send()
}

// statementSeparator splits a migration file into individual statements.
const statementSeparator = "\n-- ;;\n"

type target struct{ conn driver.Conn }

func (t target) EnsureTable(ctx context.Context) error {
	return t.conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version    UInt32,
		name       String,
		applied_at DateTime DEFAULT now()
	) ENGINE = MergeTree ORDER BY version`)
}

func (t target) Applied(ctx context.Context) ([]int, error) {
	rows, err := t.conn.Query(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []int
	for rows.Next() {
		var v uint32
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		out = append(out, int(v))
	}
	return out, rows.Err()
}

// Apply runs each statement in order. ClickHouse has no DDL transactions, so
// every statement is written to be idempotent (IF NOT EXISTS) and a failed
// migration can simply be re-run after the cause is fixed.
func (t target) Apply(ctx context.Context, m migrate.Migration) error {
	for _, stmt := range strings.Split(m.SQL, statementSeparator) {
		stmt = strings.TrimSpace(stmt)
		if stmt == "" || isOnlyComments(stmt) {
			continue
		}
		if err := t.conn.Exec(ctx, stmt); err != nil {
			return err
		}
	}
	return t.conn.Exec(ctx, `INSERT INTO schema_migrations (version, name) VALUES (?, ?)`, uint32(m.Version), m.Name) //nolint:gosec // bounded by file naming
}

func isOnlyComments(s string) bool {
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "--") {
			return false
		}
	}
	return true
}

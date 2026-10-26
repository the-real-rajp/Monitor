//go:build integration

package ch_test

import (
	"context"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/the-real-rajp/monitor/internal/metrics"
	"github.com/the-real-rajp/monitor/internal/selfmetrics"
	"github.com/the-real-rajp/monitor/internal/store/ch"
	"github.com/the-real-rajp/monitor/internal/testutil"
)

func TestMigrateIsIdempotent(t *testing.T) {
	db := testutil.CH(t)
	n, err := db.Migrate(context.Background(), slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("second migrate applied %d migrations, want 0", n)
	}
}

func TestInsertAndRollup(t *testing.T) {
	db := testutil.CH(t)
	ctx := context.Background()
	org := uuid.New()
	// Recent timestamps: metrics_raw has a 15-day TTL that ClickHouse applies
	// at insert time. Start at the previous 5-minute boundary so all ten
	// samples (spanning 90s) share one rollup bucket.
	base := time.Now().UTC().Truncate(5 * time.Minute).Add(-5 * time.Minute)
	var pts []ch.MetricPoint
	for i := 0; i < 10; i++ {
		pts = append(pts, ch.MetricPoint{
			OrgID: org, Metric: "test.metric", ResourceID: "host-a",
			Labels: map[string]string{"k": "v"},
			TS:     base.Add(time.Duration(i) * 10 * time.Second), Value: float64(i),
		})
	}
	if err := db.InsertMetrics(ctx, pts); err != nil {
		t.Fatal(err)
	}

	var count uint64
	var sum float64
	if err := db.Conn.QueryRow(ctx,
		`SELECT count(), sum(value) FROM metrics_raw WHERE org_id = ? AND metric = ?`, org.String(), "test.metric",
	).Scan(&count, &sum); err != nil {
		t.Fatal(err)
	}
	if count != 10 || sum != 45 {
		t.Errorf("raw count=%d sum=%v, want 10 and 45", count, sum)
	}

	// The 5-minute rollup: 10 samples over 90s land in one bucket.
	var bcount uint64
	var bmax, blast float64
	if err := db.Conn.QueryRow(ctx,
		`SELECT sum(count), max(max), argMaxMerge(last) FROM metrics_5m WHERE org_id = ? AND metric = ?`, org.String(), "test.metric",
	).Scan(&bcount, &bmax, &blast); err != nil {
		t.Fatal(err)
	}
	if bcount != 10 || bmax != 9 || blast != 9 {
		t.Errorf("5m rollup count=%d max=%v last=%v, want 10, 9, 9", bcount, bmax, blast)
	}
}

func TestSelfMetricsFlush(t *testing.T) {
	db := testutil.CH(t)
	reg := metrics.New()
	reg.CounterAdd("monitor.test.counter", map[string]string{"a": "b"}, 3)
	f := &selfmetrics.Flusher{
		Registry: reg, CH: db, OrgID: uuid.New(), ResourceID: "test-host", Interval: 50 * time.Millisecond,
		Log: slog.New(slog.NewTextHandler(os.Stderr, nil)),
	}
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	f.Run(ctx) // returns after ctx expires and performs a final flush

	var v float64
	var goroutines uint64
	err := db.Conn.QueryRow(context.Background(),
		`SELECT any(value), countIf(metric = 'monitor.go.goroutines') FROM metrics_raw WHERE metric = 'monitor.test.counter' AND labels['a'] = 'b' AND resource_id = 'test-host'`,
	).Scan(&v, &goroutines)
	if err != nil {
		t.Fatal(err)
	}
	if v != 3 {
		t.Errorf("flushed counter value %v, want 3", v)
	}
	var runtimeRows uint64
	if err := db.Conn.QueryRow(context.Background(), `SELECT count() FROM metrics_raw WHERE metric = 'monitor.go.goroutines'`).Scan(&runtimeRows); err != nil {
		t.Fatal(err)
	}
	if runtimeRows == 0 {
		t.Error("runtime gauges were not flushed")
	}
}

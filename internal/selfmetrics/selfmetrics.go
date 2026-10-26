// Package selfmetrics periodically snapshots the in-process metrics registry,
// adds Go runtime and connection-pool gauges, and writes everything into
// ClickHouse. This is how the server monitors itself with its own product.
package selfmetrics

import (
	"context"
	"log/slog"
	"runtime"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/the-real-rajp/monitor/internal/metrics"
	"github.com/the-real-rajp/monitor/internal/store/ch"
)

// Flusher writes registry snapshots on an interval.
type Flusher struct {
	Registry   *metrics.Registry
	CH         *ch.DB
	PG         *pgxpool.Pool
	OrgID      uuid.UUID // the org that owns the server's own telemetry
	ResourceID string    // typically the hostname
	Interval   time.Duration
	Log        *slog.Logger
}

// Run flushes until ctx is cancelled, then performs one final flush.
func (f *Flusher) Run(ctx context.Context) {
	interval := f.Interval
	if interval <= 0 {
		interval = 15 * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			flushCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			f.flush(flushCtx)
			cancel()
			return
		case <-t.C:
			f.flush(ctx)
		}
	}
}

func (f *Flusher) flush(ctx context.Context) {
	f.collectRuntime()
	now := time.Now().UTC()
	samples := f.Registry.Snapshot()
	pts := make([]ch.MetricPoint, 0, len(samples))
	for _, s := range samples {
		pts = append(pts, ch.MetricPoint{
			OrgID:      f.OrgID,
			Metric:     s.Name,
			ResourceID: f.ResourceID,
			Labels:     s.Labels,
			TS:         now,
			Value:      s.Value,
		})
	}
	start := time.Now()
	if err := f.CH.InsertMetrics(ctx, pts); err != nil {
		f.Log.Warn("self metrics flush failed", "err", err, "points", len(pts))
		f.Registry.CounterAdd("monitor.selfmetrics.flush_errors", nil, 1)
		return
	}
	f.Registry.ObserveDuration("monitor.selfmetrics.flush_seconds", nil, start)
	f.Registry.CounterAdd("monitor.selfmetrics.points_written", nil, float64(len(pts)))
}

func (f *Flusher) collectRuntime() {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	r := f.Registry
	r.GaugeSet("monitor.go.goroutines", nil, float64(runtime.NumGoroutine()))
	r.GaugeSet("monitor.go.heap_alloc_bytes", nil, float64(ms.HeapAlloc))
	r.GaugeSet("monitor.go.heap_sys_bytes", nil, float64(ms.HeapSys))
	r.GaugeSet("monitor.go.gc_count", nil, float64(ms.NumGC))
	if f.PG != nil {
		st := f.PG.Stat()
		r.GaugeSet("monitor.pg.pool.total_conns", nil, float64(st.TotalConns()))
		r.GaugeSet("monitor.pg.pool.idle_conns", nil, float64(st.IdleConns()))
		r.GaugeSet("monitor.pg.pool.acquired_conns", nil, float64(st.AcquiredConns()))
	}
}

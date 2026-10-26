package agent

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/the-real-rajp/monitor/internal/pinger"
)

// MaxBatch is the largest results batch the website accepts.
const MaxBatch = 5000

// Run executes the proxy until ctx is cancelled. It returns after a final
// best-effort upload of whatever is buffered.
func Run(ctx context.Context, cfg Config, version string, log *slog.Logger) error {
	client := NewClient(cfg.URL, cfg.Key, version)
	buf := NewBuffer(cfg.BufferMax)
	icmp := pinger.NewICMP(cfg.Privileged)
	sched := NewScheduler(icmp, cfg.PingTimeout, buf, log)
	started := time.Now()

	// Fail fast on a bad key or URL so a mistyped install is obvious.
	devices, etag, _, err := client.Devices(ctx, "")
	if err != nil {
		if IsPermanent(err) {
			return err
		}
		log.Warn("website unreachable at start, will keep trying", "err", err)
	} else {
		log.Info("device list received", "devices", len(devices))
		sched.Update(ctx, devices)
	}
	if err := client.Heartbeat(ctx, time.Since(started), 0); err != nil && !IsPermanent(err) {
		log.Warn("heartbeat failed", "err", err)
	}

	var wg sync.WaitGroup
	wg.Add(3)

	// Device list refresh.
	go func() {
		defer wg.Done()
		t := time.NewTicker(cfg.DevicesInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
			ds, newEtag, changed, err := client.Devices(ctx, etag)
			if err != nil {
				if ctx.Err() == nil {
					log.Warn("device list refresh failed", "err", err)
				}
				continue
			}
			etag = newEtag
			if changed {
				log.Info("device list updated", "devices", len(ds))
				sched.Update(ctx, ds)
			}
		}
	}()

	// Uploads.
	go func() {
		defer wg.Done()
		backoff := cfg.UploadInterval
		for {
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			if buf.Len() == 0 {
				backoff = cfg.UploadInterval
				continue
			}
			if err := upload(ctx, client, buf, log); err != nil {
				if ctx.Err() != nil {
					return
				}
				backoff = min(backoff*2, 2*time.Minute)
				log.Warn("upload failed, will retry", "err", err, "buffered", buf.Len(), "retry_in", backoff)
				continue
			}
			backoff = cfg.UploadInterval
			// Drain faster while catching up after an outage.
			if buf.Len() >= MaxBatch {
				backoff = time.Second
			}
		}
	}()

	// Heartbeats.
	go func() {
		defer wg.Done()
		t := time.NewTicker(cfg.HeartbeatInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
			if err := client.Heartbeat(ctx, time.Since(started), buf.Len()); err != nil && ctx.Err() == nil {
				log.Warn("heartbeat failed", "err", err)
			}
			if d := buf.Dropped(); d > 0 {
				log.Warn("results dropped because the buffer was full", "total_dropped", d)
			}
		}
	}()

	<-ctx.Done()
	log.Info("shutting down")
	sched.Stop()
	wg.Wait()

	// One last try to deliver what is buffered, with a short deadline.
	if buf.Len() > 0 {
		fctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := upload(fctx, client, buf, log); err != nil {
			log.Warn("final upload failed", "err", err, "lost", buf.Len())
		}
	}
	return nil
}

// upload posts one batch; on failure the batch goes back to the front of
// the buffer so order and timestamps are preserved.
func upload(ctx context.Context, client *Client, buf *Buffer, log *slog.Logger) error {
	batch := buf.Take(MaxBatch)
	if len(batch) == 0 {
		return nil
	}
	resp, err := client.PostResults(ctx, batch, buf.Len())
	if err != nil {
		if IsPermanent(err) {
			// The website rejected the batch outright; keeping it would jam
			// the queue forever. Drop it and say so.
			log.Error("batch rejected by website, discarding", "err", err, "results", len(batch))
			return nil
		}
		buf.Requeue(batch)
		return err
	}
	if resp.Rejected > 0 {
		log.Warn("website rejected some results", "rejected", resp.Rejected, "accepted", resp.Accepted)
	}
	log.Debug("uploaded", "results", len(batch), "stored", resp.Stored, "buffered", buf.Len())
	return nil
}

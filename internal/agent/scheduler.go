package agent

import (
	"context"
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/the-real-rajp/monitor/internal/pinger"
)

// Scheduler runs one loop per device, each ticking on the device's interval.
// Update reconciles the running loops against a new device list: new devices
// start, removed ones stop, changed intervals restart.
type Scheduler struct {
	pinger  pinger.Pinger
	timeout time.Duration
	buf     *Buffer
	log     *slog.Logger
	now     func() time.Time

	mu    sync.Mutex
	loops map[int]*loop
	wg    sync.WaitGroup
}

type loop struct {
	dev    Device
	cancel context.CancelFunc
}

// NewScheduler returns a scheduler that pushes results into buf.
func NewScheduler(p pinger.Pinger, timeout time.Duration, buf *Buffer, log *slog.Logger) *Scheduler {
	return &Scheduler{pinger: p, timeout: timeout, buf: buf, log: log, now: time.Now, loops: map[int]*loop{}}
}

// Update starts, stops and restarts loops to match devices.
func (s *Scheduler) Update(ctx context.Context, devices []Device) {
	s.mu.Lock()
	defer s.mu.Unlock()
	want := make(map[int]Device, len(devices))
	for _, d := range devices {
		if d.Interval < 5 {
			d.Interval = 5
		}
		want[d.ID] = d
	}
	for id, l := range s.loops {
		d, ok := want[id]
		if !ok || d != l.dev {
			l.cancel()
			delete(s.loops, id)
			if ok {
				s.log.Info("device changed, restarting", "device", id, "host", d.Host, "interval_s", d.Interval)
			} else {
				s.log.Info("device removed", "device", id, "host", l.dev.Host)
			}
		}
	}
	for id, d := range want {
		if _, ok := s.loops[id]; ok {
			continue
		}
		lctx, cancel := context.WithCancel(ctx)
		s.loops[id] = &loop{dev: d, cancel: cancel}
		s.wg.Add(1)
		go s.run(lctx, d)
	}
}

// Count is the number of running loops.
func (s *Scheduler) Count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.loops)
}

// Stop cancels every loop and waits for them to finish.
func (s *Scheduler) Stop() {
	s.mu.Lock()
	for id, l := range s.loops {
		l.cancel()
		delete(s.loops, id)
	}
	s.mu.Unlock()
	s.wg.Wait()
}

func (s *Scheduler) run(ctx context.Context, d Device) {
	defer s.wg.Done()
	interval := time.Duration(d.Interval) * time.Second
	// Spread devices across the interval so a hundred pings do not fire at once.
	jitter := time.Duration(rand.Int64N(int64(interval)))
	select {
	case <-ctx.Done():
		return
	case <-time.After(jitter):
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		s.pingOnce(ctx, d)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (s *Scheduler) pingOnce(ctx context.Context, d Device) {
	ts := s.now().Unix()
	pctx, cancel := context.WithTimeout(ctx, s.timeout+time.Second)
	defer cancel()
	rtt, ok, err := s.pinger.Ping(pctx, d.Host, s.timeout)
	if ctx.Err() != nil {
		return // shutting down; do not record a spurious timeout
	}
	if err != nil {
		// Resolution or socket failure: recorded as a timeout so the gap is
		// visible, and logged so the operator can fix the cause.
		s.log.Warn("ping failed", "device", d.ID, "host", d.Host, "err", err)
		s.buf.Push(Result{DeviceID: d.ID, TS: ts})
		return
	}
	if !ok {
		s.buf.Push(Result{DeviceID: d.ID, TS: ts})
		return
	}
	ms := float64(rtt.Microseconds()) / 1000
	s.buf.Push(Result{DeviceID: d.ID, TS: ts, RTT: &ms})
}

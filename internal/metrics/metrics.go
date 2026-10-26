// Package metrics is a tiny in-process metrics registry used by the server
// for its own telemetry. It deliberately avoids a client-library dependency:
// the server's metrics flow into the same ClickHouse tables as everything
// else, so all we need is a way to snapshot current values.
package metrics

import (
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Sample is one point taken from the registry.
type Sample struct {
	Name   string
	Labels map[string]string
	Value  float64
}

// Registry holds counters, gauges and summaries keyed by name and labels.
type Registry struct {
	mu       sync.Mutex
	counters map[string]*counter
	gauges   map[string]*gauge
	sums     map[string]*summary
}

// New returns an empty registry.
func New() *Registry {
	return &Registry{
		counters: map[string]*counter{},
		gauges:   map[string]*gauge{},
		sums:     map[string]*summary{},
	}
}

// Default is the process-wide registry.
var Default = New()

type counter struct {
	name   string
	labels map[string]string
	v      atomic.Uint64 // float64 bits
}

type gauge struct {
	name   string
	labels map[string]string
	v      atomic.Uint64
}

type summary struct {
	name   string
	labels map[string]string
	mu     sync.Mutex
	count  uint64
	sum    float64
	max    float64
}

func key(name string, labels map[string]string) string {
	if len(labels) == 0 {
		return name
	}
	ks := make([]string, 0, len(labels))
	for k := range labels {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	var b strings.Builder
	b.WriteString(name)
	for _, k := range ks {
		b.WriteByte('|')
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(labels[k])
	}
	return b.String()
}

func clone(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// CounterAdd increments a monotonically increasing counter.
func (r *Registry) CounterAdd(name string, labels map[string]string, delta float64) {
	k := key(name, labels)
	r.mu.Lock()
	c, ok := r.counters[k]
	if !ok {
		c = &counter{name: name, labels: clone(labels)}
		r.counters[k] = c
	}
	r.mu.Unlock()
	for {
		old := c.v.Load()
		nv := float64frombits(old) + delta
		if c.v.CompareAndSwap(old, float64bits(nv)) {
			return
		}
	}
}

// GaugeSet records the current value of something.
func (r *Registry) GaugeSet(name string, labels map[string]string, v float64) {
	k := key(name, labels)
	r.mu.Lock()
	g, ok := r.gauges[k]
	if !ok {
		g = &gauge{name: name, labels: clone(labels)}
		r.gauges[k] = g
	}
	r.mu.Unlock()
	g.v.Store(float64bits(v))
}

// Observe records one observation of a distribution (a request duration, a
// batch size). Snapshot emits count, sum and max for it; the max resets on
// each snapshot so it reflects the flush interval.
func (r *Registry) Observe(name string, labels map[string]string, v float64) {
	k := key(name, labels)
	r.mu.Lock()
	s, ok := r.sums[k]
	if !ok {
		s = &summary{name: name, labels: clone(labels)}
		r.sums[k] = s
	}
	r.mu.Unlock()
	s.mu.Lock()
	s.count++
	s.sum += v
	if v > s.max {
		s.max = v
	}
	s.mu.Unlock()
}

// ObserveDuration is Observe for an elapsed time, recorded in seconds.
func (r *Registry) ObserveDuration(name string, labels map[string]string, since time.Time) {
	r.Observe(name, labels, time.Since(since).Seconds())
}

// Snapshot returns the current value of every series.
func (r *Registry) Snapshot() []Sample {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Sample, 0, len(r.counters)+len(r.gauges)+3*len(r.sums))
	for _, c := range r.counters {
		out = append(out, Sample{Name: c.name, Labels: c.labels, Value: float64frombits(c.v.Load())})
	}
	for _, g := range r.gauges {
		out = append(out, Sample{Name: g.name, Labels: g.labels, Value: float64frombits(g.v.Load())})
	}
	for _, s := range r.sums {
		s.mu.Lock()
		out = append(out,
			Sample{Name: s.name + ".count", Labels: s.labels, Value: float64(s.count)},
			Sample{Name: s.name + ".sum", Labels: s.labels, Value: s.sum},
			Sample{Name: s.name + ".max", Labels: s.labels, Value: s.max},
		)
		s.max = 0
		s.mu.Unlock()
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return key("", out[i].Labels) < key("", out[j].Labels)
	})
	return out
}

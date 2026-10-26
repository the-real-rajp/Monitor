package metrics

import (
	"sync"
	"testing"
)

func find(samples []Sample, name string, labels map[string]string) float64 {
	k := key(name, labels)
	for _, s := range samples {
		if key(s.Name, s.Labels) == k {
			return s.Value
		}
	}
	return -1
}

func TestCounterGaugeSummary(t *testing.T) {
	r := New()
	r.CounterAdd("req", map[string]string{"route": "/a"}, 1)
	r.CounterAdd("req", map[string]string{"route": "/a"}, 2)
	r.CounterAdd("req", map[string]string{"route": "/b"}, 1)
	r.GaugeSet("g", nil, 5)
	r.GaugeSet("g", nil, 7)
	r.Observe("lat", nil, 0.5)
	r.Observe("lat", nil, 1.5)

	s := r.Snapshot()
	if v := find(s, "req", map[string]string{"route": "/a"}); v != 3 {
		t.Errorf("counter /a = %v, want 3", v)
	}
	if v := find(s, "req", map[string]string{"route": "/b"}); v != 1 {
		t.Errorf("counter /b = %v, want 1", v)
	}
	if v := find(s, "g", nil); v != 7 {
		t.Errorf("gauge = %v, want 7", v)
	}
	if v := find(s, "lat.count", nil); v != 2 {
		t.Errorf("count = %v, want 2", v)
	}
	if v := find(s, "lat.sum", nil); v != 2 {
		t.Errorf("sum = %v, want 2", v)
	}
	if v := find(s, "lat.max", nil); v != 1.5 {
		t.Errorf("max = %v, want 1.5", v)
	}
	// max resets per snapshot, count and sum are cumulative
	s = r.Snapshot()
	if v := find(s, "lat.max", nil); v != 0 {
		t.Errorf("max after reset = %v, want 0", v)
	}
	if v := find(s, "lat.count", nil); v != 2 {
		t.Errorf("count after snapshot = %v, want 2", v)
	}
}

func TestLabelOrderDoesNotMatter(t *testing.T) {
	r := New()
	r.CounterAdd("x", map[string]string{"a": "1", "b": "2"}, 1)
	r.CounterAdd("x", map[string]string{"b": "2", "a": "1"}, 1)
	s := r.Snapshot()
	if len(s) != 1 {
		t.Fatalf("got %d series, want 1", len(s))
	}
	if s[0].Value != 2 {
		t.Errorf("value %v, want 2", s[0].Value)
	}
}

func TestConcurrentCounter(t *testing.T) {
	r := New()
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 1000; j++ {
				r.CounterAdd("c", nil, 1)
			}
		}()
	}
	wg.Wait()
	if v := find(r.Snapshot(), "c", nil); v != 50000 {
		t.Errorf("counter = %v, want 50000", v)
	}
}

func TestSnapshotDoesNotAliasLabels(t *testing.T) {
	r := New()
	labels := map[string]string{"k": "v"}
	r.GaugeSet("g", labels, 1)
	labels["k"] = "changed"
	s := r.Snapshot()
	if s[0].Labels["k"] != "v" {
		t.Error("registry stored caller's map instead of a copy")
	}
}

package agent

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestBufferCapAndRequeue(t *testing.T) {
	b := NewBuffer(5)
	for i := 0; i < 7; i++ {
		b.Push(Result{DeviceID: i})
	}
	if b.Len() != 5 || b.Dropped() != 2 {
		t.Fatalf("len=%d dropped=%d", b.Len(), b.Dropped())
	}
	got := b.Take(2)
	if got[0].DeviceID != 2 || got[1].DeviceID != 3 {
		t.Fatalf("oldest first expected, got %+v", got)
	}
	b.Requeue(got)
	all := b.Take(10)
	if len(all) != 5 || all[0].DeviceID != 2 || all[4].DeviceID != 6 {
		t.Fatalf("requeue broke order: %+v", all)
	}
	if b.Len() != 0 {
		t.Fatal("buffer should be empty")
	}
}

func TestConfigFileEnvValidate(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.env")
	os.WriteFile(path, []byte("# comment\nMONITOR_URL=https://m.example.com/\nMONITOR_KEY=\"mon_abc_def\"\nMONITOR_UPLOAD_INTERVAL=5s\n"), 0o600)
	cfg := Defaults()
	if err := cfg.LoadFile(path, false); err != nil {
		t.Fatal(err)
	}
	if cfg.URL != "https://m.example.com" || cfg.Key != "mon_abc_def" || cfg.UploadInterval != 5*time.Second {
		t.Fatalf("unexpected config %+v", cfg)
	}
	t.Setenv("MONITOR_LOG_LEVEL", "DEBUG")
	if err := cfg.LoadEnv(); err != nil || cfg.LogLevel != "debug" {
		t.Fatalf("env override: %v %q", err, cfg.LogLevel)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	cfg.Key = ""
	cfg.PingTimeout = time.Minute
	if err := cfg.Validate(); err == nil {
		t.Fatal("invalid config accepted")
	}
	os.WriteFile(path, []byte("NOPE=1\n"), 0o600)
	if err := cfg.LoadFile(path, false); err == nil {
		t.Fatal("unknown key accepted")
	}
	if err := cfg.LoadFile(filepath.Join(dir, "missing"), true); err != nil {
		t.Fatal("optional missing file should not error")
	}
}

type fakePinger struct {
	mu    sync.Mutex
	calls map[string]int
	down  map[string]bool
}

func (f *fakePinger) Ping(_ context.Context, host string, _ time.Duration) (time.Duration, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls[host]++
	if f.down[host] {
		return 0, false, nil
	}
	return 1500 * time.Microsecond, true, nil
}

func TestSchedulerReconcilesAndRecords(t *testing.T) {
	fp := &fakePinger{calls: map[string]int{}, down: map[string]bool{"10.0.0.9": true}}
	buf := NewBuffer(1000)
	s := NewScheduler(fp, time.Second, buf, slog.New(slog.NewTextHandler(os.Stderr, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	s.Update(ctx, []Device{{ID: 1, Host: "10.0.0.1", Interval: 5}, {ID: 2, Host: "10.0.0.9", Interval: 5}})
	if s.Count() != 2 {
		t.Fatalf("loops=%d", s.Count())
	}
	// Jitter is up to one interval; wait for both first pings.
	deadline := time.Now().Add(7 * time.Second)
	for buf.Len() < 2 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	got := buf.Take(10)
	if len(got) < 2 {
		t.Fatalf("expected 2 results, got %d", len(got))
	}
	for _, r := range got {
		switch r.DeviceID {
		case 1:
			if r.RTT == nil || *r.RTT != 1.5 {
				t.Errorf("device 1 rtt %v", r.RTT)
			}
		case 2:
			if r.RTT != nil {
				t.Errorf("device 2 should be a timeout")
			}
		}
		if r.TS == 0 {
			t.Error("timestamp missing")
		}
	}

	s.Update(ctx, []Device{{ID: 1, Host: "10.0.0.1", Interval: 10}}) // 2 removed, 1 restarted
	if s.Count() != 1 {
		t.Fatalf("loops after update=%d", s.Count())
	}
	s.Stop()
	if s.Count() != 0 {
		t.Fatal("loops remain after stop")
	}
}

func TestClientAgainstFakeWebsite(t *testing.T) {
	var mu sync.Mutex
	var posted []Result
	var gotKey, gotEtag string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		gotKey = r.Header.Get("Authorization")
		if gotKey != "Bearer mon_k" {
			w.WriteHeader(401)
			json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": "unauthorized", "message": "invalid agent key"}})
			return
		}
		switch r.URL.Path {
		case "/api/agent/devices":
			gotEtag = r.Header.Get("If-None-Match")
			if gotEtag == `"abc"` {
				w.WriteHeader(304)
				return
			}
			w.Header().Set("ETag", `"abc"`)
			json.NewEncoder(w).Encode(map[string]any{"devices": []Device{{ID: 7, Host: "10.0.0.7", Interval: 30}}})
		case "/api/agent/results":
			var body struct {
				Results []Result `json:"results"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			posted = append(posted, body.Results...)
			json.NewEncoder(w).Encode(ResultsResponse{Accepted: len(body.Results), Stored: len(body.Results)})
		case "/api/agent/heartbeat":
			json.NewEncoder(w).Encode(map[string]any{"server_time": "x"})
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "mon_k", "test")
	ctx := context.Background()
	devs, etag, changed, err := c.Devices(ctx, "")
	if err != nil || !changed || len(devs) != 1 || devs[0].ID != 7 || etag != `"abc"` {
		t.Fatalf("devices: %v %v %v %q", err, changed, devs, etag)
	}
	_, etag2, changed, err := c.Devices(ctx, etag)
	if err != nil || changed || etag2 != etag {
		t.Fatalf("etag round trip: %v %v %q", err, changed, etag2)
	}
	rtt := 2.5
	resp, err := c.PostResults(ctx, []Result{{DeviceID: 7, TS: 1700000000, RTT: &rtt}, {DeviceID: 7, TS: 1700000030}}, 0)
	if err != nil || resp.Stored != 2 {
		t.Fatalf("post: %v %+v", err, resp)
	}
	if err := c.Heartbeat(ctx, time.Minute, 3); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	if len(posted) != 2 || posted[1].RTT != nil || *posted[0].RTT != 2.5 {
		t.Fatalf("posted %+v", posted)
	}
	mu.Unlock()

	bad := NewClient(srv.URL, "mon_wrong", "test")
	_, _, _, err = bad.Devices(ctx, "")
	if !IsPermanent(err) {
		t.Fatalf("bad key should be permanent error, got %v", err)
	}

	// upload() discards on permanent error and requeues on transient error.
	buf := NewBuffer(100)
	buf.Push(Result{DeviceID: 7, TS: 1})
	if err := upload(ctx, bad, buf, slog.New(slog.NewTextHandler(os.Stderr, nil))); err != nil || buf.Len() != 0 {
		t.Fatalf("permanent: err=%v len=%d", err, buf.Len())
	}
	srv.Close()
	buf.Push(Result{DeviceID: 7, TS: 2})
	if err := upload(ctx, c, buf, slog.New(slog.NewTextHandler(os.Stderr, nil))); err == nil || buf.Len() != 1 {
		t.Fatalf("transient: err=%v len=%d", err, buf.Len())
	}
}

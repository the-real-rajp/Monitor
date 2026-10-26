package migrate

import (
	"context"
	"errors"
	"log/slog"
	"testing"
	"testing/fstest"
)

type fakeTarget struct {
	applied []int
	fail    int
}

func (f *fakeTarget) EnsureTable(context.Context) error { return nil }
func (f *fakeTarget) Applied(context.Context) ([]int, error) {
	return append([]int(nil), f.applied...), nil
}
func (f *fakeTarget) Apply(_ context.Context, m Migration) error {
	if m.Version == f.fail {
		return errors.New("boom")
	}
	f.applied = append(f.applied, m.Version)
	return nil
}

func TestLoadSortsAndValidates(t *testing.T) {
	fsys := fstest.MapFS{
		"m/0002_second.sql": {Data: []byte("b")},
		"m/0001_first.sql":  {Data: []byte("a")},
		"m/README.md":       {Data: []byte("ignored? no: must fail")},
	}
	if _, err := Load(fsys, "m"); err == nil {
		t.Fatal("non-migration file accepted")
	}
	delete(fsys, "m/README.md")
	ms, err := Load(fsys, "m")
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) != 2 || ms[0].Version != 1 || ms[1].Version != 2 || ms[1].Name != "second" {
		t.Errorf("unexpected load result: %+v", ms)
	}
	fsys["m/0002_dup.sql"] = &fstest.MapFile{Data: []byte("c")}
	if _, err := Load(fsys, "m"); err == nil {
		t.Fatal("duplicate version accepted")
	}
}

func TestRunAppliesOnlyPending(t *testing.T) {
	ms := []Migration{{Version: 1, Name: "a"}, {Version: 2, Name: "b"}, {Version: 3, Name: "c"}}
	tg := &fakeTarget{applied: []int{1}}
	n, err := Run(context.Background(), slog.Default(), tg, ms)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 || len(tg.applied) != 3 {
		t.Errorf("applied %d (%v), want 2 new", n, tg.applied)
	}
	n, err = Run(context.Background(), slog.Default(), tg, ms)
	if err != nil || n != 0 {
		t.Errorf("second run applied %d, err %v", n, err)
	}
}

func TestRunStopsAtFailure(t *testing.T) {
	ms := []Migration{{Version: 1, Name: "a"}, {Version: 2, Name: "b"}, {Version: 3, Name: "c"}}
	tg := &fakeTarget{fail: 2}
	n, err := Run(context.Background(), slog.Default(), tg, ms)
	if err == nil {
		t.Fatal("expected error")
	}
	if n != 1 || len(tg.applied) != 1 {
		t.Errorf("applied %v after failure, want only version 1", tg.applied)
	}
}

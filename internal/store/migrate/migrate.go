// Package migrate is a small, dependency-free runner for versioned SQL
// migrations embedded in the binary. It is shared by the PostgreSQL and
// ClickHouse stores, which differ only in how a migration is applied and
// recorded.
//
// Migration files are named NNNN_description.sql. They are applied in
// ascending order and never re-run. There is deliberately no "down"
// direction: production rollbacks are done with a new forward migration.
package migrate

import (
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"path"
	"regexp"
	"sort"
	"strconv"
)

// Migration is one versioned SQL file.
type Migration struct {
	Version int
	Name    string
	SQL     string
}

// Target is implemented by each database store.
type Target interface {
	// EnsureTable creates the bookkeeping table if it does not exist.
	EnsureTable(ctx context.Context) error
	// Applied returns the versions already applied, in any order.
	Applied(ctx context.Context) ([]int, error)
	// Apply runs the migration and records it. Implementations should make
	// this as atomic as the database allows.
	Apply(ctx context.Context, m Migration) error
}

var fileRe = regexp.MustCompile(`^(\d{4})_([a-z0-9_]+)\.sql$`)

// Load reads all migrations from dir inside fsys.
func Load(fsys fs.FS, dir string) ([]Migration, error) {
	entries, err := fs.ReadDir(fsys, dir)
	if err != nil {
		return nil, fmt.Errorf("read migrations dir: %w", err)
	}
	var out []Migration
	seen := map[int]string{}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		m := fileRe.FindStringSubmatch(e.Name())
		if m == nil {
			return nil, fmt.Errorf("migration %q does not match NNNN_name.sql", e.Name())
		}
		v, _ := strconv.Atoi(m[1])
		if prev, dup := seen[v]; dup {
			return nil, fmt.Errorf("duplicate migration version %d: %s and %s", v, prev, e.Name())
		}
		seen[v] = e.Name()
		b, err := fs.ReadFile(fsys, path.Join(dir, e.Name()))
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", e.Name(), err)
		}
		out = append(out, Migration{Version: v, Name: m[2], SQL: string(b)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Version < out[j].Version })
	return out, nil
}

// Run applies every migration in ms that t has not yet applied.
// It returns the number of migrations applied.
func Run(ctx context.Context, log *slog.Logger, t Target, ms []Migration) (int, error) {
	if err := t.EnsureTable(ctx); err != nil {
		return 0, fmt.Errorf("ensure migrations table: %w", err)
	}
	applied, err := t.Applied(ctx)
	if err != nil {
		return 0, fmt.Errorf("read applied migrations: %w", err)
	}
	done := make(map[int]bool, len(applied))
	for _, v := range applied {
		done[v] = true
	}
	n := 0
	for _, m := range ms {
		if done[m.Version] {
			continue
		}
		log.Info("applying migration", "version", m.Version, "name", m.Name)
		if err := t.Apply(ctx, m); err != nil {
			return n, fmt.Errorf("migration %04d_%s: %w", m.Version, m.Name, err)
		}
		n++
	}
	return n, nil
}

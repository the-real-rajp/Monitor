// Command monitor-server runs the Monitor API, web UI and background
// services. Subcommands:
//
//	serve           run the server (default)
//	migrate         apply pending database migrations and exit
//	user create     create a user, and the org if none exists yet
//	user list       list users
//	version         print the build version
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"golang.org/x/term"

	"github.com/the-real-rajp/monitor/internal/api"
	"github.com/the-real-rajp/monitor/internal/auth"
	"github.com/the-real-rajp/monitor/internal/config"
	"github.com/the-real-rajp/monitor/internal/metrics"
	"github.com/the-real-rajp/monitor/internal/selfmetrics"
	"github.com/the-real-rajp/monitor/internal/store/ch"
	"github.com/the-real-rajp/monitor/internal/store/pg"
	"github.com/the-real-rajp/monitor/internal/store/pg/sqlc"
	"github.com/the-real-rajp/monitor/internal/version"
	"github.com/the-real-rajp/monitor/internal/webui"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	cmd := "serve"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	switch cmd {
	case "serve":
		return serve()
	case "migrate":
		return migrateOnly()
	case "user":
		return userCmd(args)
	case "version":
		fmt.Println(version.Version)
		return nil
	case "help", "-h", "--help":
		fmt.Print(usage)
		return nil
	default:
		return fmt.Errorf("unknown command %q\n%s", cmd, usage)
	}
}

const usage = `usage: monitor-server <command>

commands:
  serve          run the API server (default)
  migrate        apply pending migrations and exit
  user create    create a user (and the first org)
  user list      list users
  version        print the version

configuration is read from MONITOR_* environment variables; see docs/DEVELOPMENT.md
`

func newLogger(cfg config.Server) *slog.Logger {
	var level slog.Level
	if err := level.UnmarshalText([]byte(cfg.LogLevel)); err != nil {
		level = slog.LevelInfo
	}
	opts := &slog.HandlerOptions{Level: level}
	var h slog.Handler
	if cfg.LogFormat == "text" {
		h = slog.NewTextHandler(os.Stderr, opts)
	} else {
		h = slog.NewJSONHandler(os.Stderr, opts)
	}
	return slog.New(h)
}

// stores opens both databases and optionally migrates them.
func stores(ctx context.Context, cfg config.Server, log *slog.Logger, migrate bool) (*pg.DB, *ch.DB, error) {
	pgdb, err := pg.Open(ctx, cfg.PostgresURL)
	if err != nil {
		return nil, nil, err
	}
	chdb, err := ch.Open(ctx, cfg.ClickHouseURL)
	if err != nil {
		pgdb.Close()
		return nil, nil, err
	}
	if migrate {
		if n, err := pgdb.Migrate(ctx, log); err != nil {
			pgdb.Close()
			_ = chdb.Close()
			return nil, nil, fmt.Errorf("postgres migrate: %w", err)
		} else if n > 0 {
			log.Info("postgres migrations applied", "count", n)
		}
		if n, err := chdb.Migrate(ctx, log); err != nil {
			pgdb.Close()
			_ = chdb.Close()
			return nil, nil, fmt.Errorf("clickhouse migrate: %w", err)
		} else if n > 0 {
			log.Info("clickhouse migrations applied", "count", n)
		}
	}
	return pgdb, chdb, nil
}

func serve() error {
	cfg, err := config.LoadServer()
	if err != nil {
		return err
	}
	log := newLogger(cfg)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pgdb, chdb, err := stores(ctx, cfg, log, cfg.MigrateOnStart)
	if err != nil {
		return err
	}
	defer pgdb.Close()
	defer func() { _ = chdb.Close() }()

	reg := metrics.Default
	srv := api.New(cfg, log, pgdb, chdb, reg, webui.Handler())
	httpSrv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       2 * time.Minute,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}

	// Self metrics are owned by the first org; until one exists they are
	// dropped, which only happens before the first user is created.
	go func() {
		orgID, err := firstOrgID(ctx, pgdb)
		if err != nil {
			log.Warn("self metrics disabled until an org exists", "err", err)
			return
		}
		host, _ := os.Hostname()
		f := &selfmetrics.Flusher{
			Registry: reg, CH: chdb, PG: pgdb.Pool, OrgID: orgID, ResourceID: host,
			Interval: cfg.SelfMetricsInterval, Log: log,
		}
		f.Run(ctx)
	}()
	go sessionJanitor(ctx, pgdb, log)

	errCh := make(chan error, 1)
	go func() {
		log.Info("monitor-server listening", "addr", cfg.ListenAddr, "version", version.Version, "ui_embedded", webui.Embedded)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return httpSrv.Shutdown(shutdownCtx)
}

// firstOrgID waits until an org exists and returns its id.
func firstOrgID(ctx context.Context, db *pg.DB) (uuid.UUID, error) {
	for {
		var id uuid.UUID
		err := db.Pool.QueryRow(ctx, `SELECT id FROM orgs ORDER BY created_at LIMIT 1`).Scan(&id)
		if err == nil {
			return id, nil
		}
		select {
		case <-ctx.Done():
			return id, ctx.Err()
		case <-time.After(30 * time.Second):
		}
	}
}

// sessionJanitor deletes expired sessions hourly.
func sessionJanitor(ctx context.Context, db *pg.DB, log *slog.Logger) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n, err := db.Q.DeleteExpiredSessions(ctx); err != nil {
				log.Warn("session cleanup failed", "err", err)
			} else if n > 0 {
				log.Info("expired sessions removed", "count", n)
			}
		}
	}
}

func migrateOnly() error {
	cfg, err := config.LoadServer()
	if err != nil {
		return err
	}
	log := newLogger(cfg)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	pgdb, chdb, err := stores(ctx, cfg, log, true)
	if err != nil {
		return err
	}
	pgdb.Close()
	return chdb.Close()
}

func userCmd(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: monitor-server user <create|list>")
	}
	switch args[0] {
	case "create":
		return userCreate(args[1:])
	case "list":
		return userList()
	default:
		return fmt.Errorf("unknown user subcommand %q", args[0])
	}
}

func userCreate(args []string) error {
	fs := flag.NewFlagSet("user create", flag.ContinueOnError)
	email := fs.String("email", "", "email address (required)")
	name := fs.String("name", "", "display name (required)")
	role := fs.String("role", "admin", "admin, member or viewer")
	org := fs.String("org", "", "organisation name; required only when creating the first user")
	pwStdin := fs.Bool("password-stdin", false, "read the password from stdin instead of prompting")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *email == "" || *name == "" {
		return errors.New("--email and --name are required")
	}
	normEmail, err := api.NormalizeEmail(*email)
	if err != nil {
		return err
	}
	r := sqlc.UserRole(*role)
	if !r.Valid() {
		return errors.New("--role must be admin, member or viewer")
	}
	pw, err := readPassword(*pwStdin)
	if err != nil {
		return err
	}
	if err := auth.ValidatePassword(pw); err != nil {
		return err
	}
	hash, err := auth.HashPassword(pw)
	if err != nil {
		return err
	}

	cfg, err := config.LoadServer()
	if err != nil {
		return err
	}
	log := newLogger(cfg)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pgdb, err := pg.Open(ctx, cfg.PostgresURL)
	if err != nil {
		return err
	}
	defer pgdb.Close()
	if _, err := pgdb.Migrate(ctx, log); err != nil {
		return err
	}

	return pgdb.WithTx(ctx, func(q *sqlc.Queries) error {
		n, err := q.CountOrgs(ctx)
		if err != nil {
			return err
		}
		var orgID uuid.UUID
		switch {
		case n == 0:
			if *org == "" {
				return errors.New("no organisation exists yet; pass --org to create one")
			}
			o, err := q.CreateOrg(ctx, sqlc.CreateOrgParams{Name: *org, Slug: slugify(*org)})
			if err != nil {
				return err
			}
			orgID = o.ID
			fmt.Printf("created org %q (%s)\n", o.Name, o.ID)
		case *org != "":
			o, err := q.GetOrgBySlug(ctx, slugify(*org))
			if err != nil {
				return fmt.Errorf("org %q not found", *org)
			}
			orgID = o.ID
		default:
			if err := pgdb.Pool.QueryRow(ctx, `SELECT id FROM orgs ORDER BY created_at LIMIT 1`).Scan(&orgID); err != nil {
				return err
			}
		}
		u, err := q.CreateUser(ctx, sqlc.CreateUserParams{OrgID: orgID, Email: normEmail, Name: *name, Role: r, PasswordHash: hash})
		if err != nil {
			return err
		}
		fmt.Printf("created user %s (%s) with role %s\n", u.Email, u.ID, u.Role)
		return nil
	})
}

func readPassword(fromStdin bool) (string, error) {
	if fromStdin || !term.IsTerminal(int(os.Stdin.Fd())) {
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil && line == "" {
			return "", fmt.Errorf("read password from stdin: %w", err)
		}
		return strings.TrimRight(line, "\r\n"), nil
	}
	fmt.Fprint(os.Stderr, "Password: ")
	b, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", err
	}
	fmt.Fprint(os.Stderr, "Confirm password: ")
	c, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", err
	}
	if string(b) != string(c) {
		return "", errors.New("passwords do not match")
	}
	return string(b), nil
}

func userList() error {
	cfg, err := config.LoadServer()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pgdb, err := pg.Open(ctx, cfg.PostgresURL)
	if err != nil {
		return err
	}
	defer pgdb.Close()
	rows, err := pgdb.Pool.Query(ctx, `SELECT u.email, u.name, u.role::text, o.name, u.disabled_at IS NOT NULL
		FROM users u JOIN orgs o ON o.id = u.org_id ORDER BY o.name, u.email`)
	if err != nil {
		return err
	}
	defer rows.Close()
	fmt.Printf("%-40s %-30s %-8s %-20s %s\n", "EMAIL", "NAME", "ROLE", "ORG", "STATUS")
	for rows.Next() {
		var email, name, role, orgName string
		var disabled bool
		if err := rows.Scan(&email, &name, &role, &orgName, &disabled); err != nil {
			return err
		}
		status := "active"
		if disabled {
			status = "disabled"
		}
		fmt.Printf("%-40s %-30s %-8s %-20s %s\n", email, name, role, orgName, status)
	}
	return rows.Err()
}

// slugify turns an org name into a URL-safe slug.
func slugify(s string) string {
	var b strings.Builder
	lastDash := true
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			lastDash = false
		case !lastDash:
			b.WriteByte('-')
			lastDash = true
		}
	}
	return strings.Trim(b.String(), "-")
}

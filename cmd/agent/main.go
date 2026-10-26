// Command monitor-agent is the on-prem proxy. It pings the devices assigned
// to it in the Monitor dashboard and reports results to the website.
//
//	monitor-agent [-config /etc/monitor-agent/agent.env] [-url URL] [-key KEY]
//	monitor-agent version
//	monitor-agent check            validate config and reach the website, then exit
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/the-real-rajp/monitor/internal/agent"
)

// Version is set at build time with -ldflags "-X main.Version=v1.2.3".
var Version = "dev"

const defaultConfig = "/etc/monitor-agent/agent.env"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "version" {
		fmt.Println(Version)
		return
	}
	check := len(os.Args) > 1 && os.Args[1] == "check"
	args := os.Args[1:]
	if check {
		args = args[1:]
	}

	fs := flag.NewFlagSet("monitor-agent", flag.ExitOnError)
	configPath := fs.String("config", defaultConfig, "environment-style config file")
	url := fs.String("url", "", "website base URL (overrides MONITOR_URL)")
	key := fs.String("key", "", "agent key (overrides MONITOR_KEY)")
	_ = fs.Parse(args)

	cfg := agent.Defaults()
	optional := *configPath == defaultConfig
	if err := cfg.LoadFile(*configPath, optional); err != nil {
		fatal(err)
	}
	if err := cfg.LoadEnv(); err != nil {
		fatal(err)
	}
	if *url != "" {
		cfg.URL = *url
	}
	if *key != "" {
		cfg.Key = *key
	}
	if err := cfg.Validate(); err != nil {
		fatal(err)
	}

	var level slog.Level
	if err := level.UnmarshalText([]byte(cfg.LogLevel)); err != nil {
		level = slog.LevelInfo
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))

	if check {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		devices, _, _, err := agent.NewClient(cfg.URL, cfg.Key, Version).Devices(ctx, "")
		if err != nil {
			fatal(fmt.Errorf("cannot reach website: %w", err))
		}
		fmt.Printf("ok: website reachable, %d device(s) assigned to this proxy\n", len(devices))
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	log.Info("monitor-agent starting", "version", Version, "url", cfg.URL)
	if err := agent.Run(ctx, cfg, Version, log); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "monitor-agent:", err)
	os.Exit(1)
}

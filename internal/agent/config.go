// Package agent implements monitor-agent, the on-prem proxy: it pulls its
// device list from the website, pings each device on its interval, and
// pushes results outbound over HTTPS, buffering while the site is unreachable.
package agent

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is read from an environment-style file (KEY=value per line, the
// format systemd's EnvironmentFile uses), then overridden by real environment
// variables, then by flags. Only URL and Key are required.
type Config struct {
	URL string // base URL of the website, e.g. https://monitor.example.com
	Key string // agent key, mon_<prefix>_<secret>

	UploadInterval    time.Duration // how often buffered results are posted
	HeartbeatInterval time.Duration
	DevicesInterval   time.Duration // how often the device list is refreshed
	PingTimeout       time.Duration
	BufferMax         int    // results kept while the website is unreachable
	Privileged        string // "auto", "yes" or "no": raw ICMP sockets vs unprivileged datagram ICMP
	LogLevel          string
}

// Defaults returns the configuration before any file, env or flag is applied.
func Defaults() Config {
	return Config{
		UploadInterval:    10 * time.Second,
		HeartbeatInterval: 60 * time.Second,
		DevicesInterval:   60 * time.Second,
		PingTimeout:       3 * time.Second,
		BufferMax:         500_000, // ~24h of 50 devices at 10s, about 20 MB
		Privileged:        "auto",
		LogLevel:          "info",
	}
}

// LoadFile applies KEY=value lines from path. A missing file is not an error
// when optional is true.
func (c *Config) LoadFile(path string, optional bool) error {
	f, err := os.Open(path)
	if err != nil {
		if optional && errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	line := 0
	for sc.Scan() {
		line++
		s := strings.TrimSpace(sc.Text())
		if s == "" || strings.HasPrefix(s, "#") {
			continue
		}
		k, v, ok := strings.Cut(s, "=")
		if !ok {
			return fmt.Errorf("%s:%d: expected KEY=value", path, line)
		}
		v = strings.Trim(strings.TrimSpace(v), `"'`)
		if err := c.set(strings.TrimSpace(k), v); err != nil {
			return fmt.Errorf("%s:%d: %w", path, line, err)
		}
	}
	return sc.Err()
}

// LoadEnv applies MONITOR_* environment variables.
func (c *Config) LoadEnv() error {
	for _, k := range []string{"MONITOR_URL", "MONITOR_KEY", "MONITOR_UPLOAD_INTERVAL", "MONITOR_HEARTBEAT_INTERVAL",
		"MONITOR_DEVICES_INTERVAL", "MONITOR_PING_TIMEOUT", "MONITOR_BUFFER_MAX", "MONITOR_PRIVILEGED", "MONITOR_LOG_LEVEL"} {
		if v, ok := os.LookupEnv(k); ok && v != "" {
			if err := c.set(k, v); err != nil {
				return fmt.Errorf("%s: %w", k, err)
			}
		}
	}
	return nil
}

func (c *Config) set(key, v string) error {
	var err error
	switch key {
	case "MONITOR_URL":
		c.URL = strings.TrimRight(v, "/")
	case "MONITOR_KEY":
		c.Key = v
	case "MONITOR_UPLOAD_INTERVAL":
		c.UploadInterval, err = time.ParseDuration(v)
	case "MONITOR_HEARTBEAT_INTERVAL":
		c.HeartbeatInterval, err = time.ParseDuration(v)
	case "MONITOR_DEVICES_INTERVAL":
		c.DevicesInterval, err = time.ParseDuration(v)
	case "MONITOR_PING_TIMEOUT":
		c.PingTimeout, err = time.ParseDuration(v)
	case "MONITOR_BUFFER_MAX":
		c.BufferMax, err = strconv.Atoi(v)
	case "MONITOR_PRIVILEGED":
		c.Privileged = strings.ToLower(v)
	case "MONITOR_LOG_LEVEL":
		c.LogLevel = strings.ToLower(v)
	default:
		return fmt.Errorf("unknown setting %q", key)
	}
	return err
}

// Validate checks required values and sane ranges.
func (c *Config) Validate() error {
	var errs []error
	if !strings.HasPrefix(c.URL, "http://") && !strings.HasPrefix(c.URL, "https://") {
		errs = append(errs, errors.New("MONITOR_URL must start with http:// or https://"))
	}
	if !strings.HasPrefix(c.Key, "mon_") {
		errs = append(errs, errors.New("MONITOR_KEY is required (create a proxy in the dashboard to get one)"))
	}
	if c.UploadInterval < time.Second || c.UploadInterval > 5*time.Minute {
		errs = append(errs, errors.New("MONITOR_UPLOAD_INTERVAL must be between 1s and 5m"))
	}
	if c.HeartbeatInterval < 10*time.Second || c.HeartbeatInterval > 10*time.Minute {
		errs = append(errs, errors.New("MONITOR_HEARTBEAT_INTERVAL must be between 10s and 10m"))
	}
	if c.DevicesInterval < 10*time.Second || c.DevicesInterval > time.Hour {
		errs = append(errs, errors.New("MONITOR_DEVICES_INTERVAL must be between 10s and 1h"))
	}
	if c.PingTimeout < 200*time.Millisecond || c.PingTimeout > 10*time.Second {
		errs = append(errs, errors.New("MONITOR_PING_TIMEOUT must be between 200ms and 10s"))
	}
	if c.BufferMax < 1000 {
		errs = append(errs, errors.New("MONITOR_BUFFER_MAX must be at least 1000"))
	}
	switch c.Privileged {
	case "auto", "yes", "no":
	default:
		errs = append(errs, errors.New("MONITOR_PRIVILEGED must be auto, yes or no"))
	}
	return errors.Join(errs...)
}

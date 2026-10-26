// Package pinger sends one ICMP echo and reports the round-trip time.
//
// On Linux it first tries an unprivileged ICMP datagram socket, which works
// when the process's group is inside net.ipv4.ping_group_range (the install
// script sets this). If that is refused it falls back to a raw socket, which
// needs CAP_NET_RAW; the systemd unit grants that capability so the service
// still runs as an unprivileged user.
package pinger

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	probing "github.com/prometheus-community/pro-bing"
)

// Pinger pings hosts. Implementations must be safe for concurrent use.
type Pinger interface {
	// Ping returns the round-trip time and true when a reply arrived within
	// timeout, or false on timeout. err is set only for failures that are
	// not the target's fault (bad hostname, no socket permission).
	Ping(ctx context.Context, host string, timeout time.Duration) (rtt time.Duration, ok bool, err error)
}

// ICMP pings with pro-bing.
type ICMP struct {
	mode       string // "auto", "yes" (privileged), "no" (unprivileged)
	mu         sync.Mutex
	privileged *bool // resolved mode once auto-detection has run
}

// NewICMP returns an ICMP pinger. mode is "auto", "yes" or "no".
func NewICMP(mode string) *ICMP {
	p := &ICMP{mode: mode}
	switch mode {
	case "yes":
		t := true
		p.privileged = &t
	case "no":
		f := false
		p.privileged = &f
	}
	return p
}

// Ping implements Pinger.
func (p *ICMP) Ping(ctx context.Context, host string, timeout time.Duration) (time.Duration, bool, error) {
	priv := p.resolve()
	rtt, ok, err := pingOnce(ctx, host, timeout, priv)
	if err != nil && p.mode == "auto" && !priv && isPermission(err) {
		// Unprivileged sockets refused: switch to raw sockets for good.
		p.setPrivileged(true)
		rtt, ok, err = pingOnce(ctx, host, timeout, true)
	}
	return rtt, ok, err
}

// Privileged reports which socket type is in use (after the first ping).
func (p *ICMP) Privileged() bool {
	return p.resolve()
}

func (p *ICMP) resolve() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.privileged == nil {
		f := false
		p.privileged = &f
	}
	return *p.privileged
}

func (p *ICMP) setPrivileged(v bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.privileged = &v
}

func pingOnce(ctx context.Context, host string, timeout time.Duration, privileged bool) (time.Duration, bool, error) {
	pg, err := probing.NewPinger(host)
	if err != nil {
		return 0, false, fmt.Errorf("resolve %s: %w", host, err)
	}
	pg.SetPrivileged(privileged)
	pg.Count = 1
	pg.Timeout = timeout
	pg.Interval = timeout // irrelevant with Count=1 but must be > 0
	pg.RecordRtts = true

	done := make(chan error, 1)
	go func() { done <- pg.Run() }()
	select {
	case <-ctx.Done():
		pg.Stop()
		<-done
		return 0, false, ctx.Err()
	case err := <-done:
		if err != nil {
			return 0, false, err
		}
	}
	st := pg.Statistics()
	if st.PacketsRecv == 0 {
		return 0, false, nil
	}
	return st.MinRtt, true, nil
}

func isPermission(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "permission denied") || strings.Contains(s, "operation not permitted") ||
		strings.Contains(s, "socket: ") && strings.Contains(s, "not permitted") || errors.Is(err, errPermission)
}

var errPermission = errors.New("permission")

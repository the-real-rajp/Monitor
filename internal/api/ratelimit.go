package api

import (
	"sync"
	"time"
)

// rateLimiter is a fixed-window counter keyed by string, used to slow down
// password guessing on the login endpoint. Memory-only; per replica.
type rateLimiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	hits   map[string]*bucket
	last   time.Time
}

type bucket struct {
	count int
	start time.Time
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	return &rateLimiter{limit: limit, window: window, hits: map[string]*bucket{}, last: time.Now()}
}

// allow records a hit for key and reports whether it is within the limit.
func (l *rateLimiter) allow(key string) bool {
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.last) > l.window {
		// Cheap periodic sweep so the map cannot grow without bound.
		for k, b := range l.hits {
			if now.Sub(b.start) > l.window {
				delete(l.hits, k)
			}
		}
		l.last = now
	}
	b, ok := l.hits[key]
	if !ok || now.Sub(b.start) > l.window {
		l.hits[key] = &bucket{count: 1, start: now}
		return true
	}
	b.count++
	return b.count <= l.limit
}

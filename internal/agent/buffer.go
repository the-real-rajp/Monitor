package agent

import "sync"

// Buffer is a bounded FIFO of results. When full, the oldest results are
// dropped and counted, so a very long website outage degrades the history
// rather than growing memory without limit.
type Buffer struct {
	mu      sync.Mutex
	items   []Result
	max     int
	dropped int64
}

// NewBuffer returns a buffer holding at most max results.
func NewBuffer(max int) *Buffer {
	return &Buffer{max: max}
}

// Push appends results, dropping the oldest if the cap is exceeded.
func (b *Buffer) Push(rs ...Result) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.items = append(b.items, rs...)
	if over := len(b.items) - b.max; over > 0 {
		b.dropped += int64(over)
		b.items = append([]Result(nil), b.items[over:]...)
	}
}

// Take removes and returns up to n of the oldest results.
func (b *Buffer) Take(n int) []Result {
	b.mu.Lock()
	defer b.mu.Unlock()
	if n > len(b.items) {
		n = len(b.items)
	}
	out := append([]Result(nil), b.items[:n]...)
	b.items = b.items[n:]
	if len(b.items) == 0 {
		b.items = nil // let the backing array go
	}
	return out
}

// Requeue puts results back at the front, preserving order, after a failed
// upload. Anything beyond the cap is dropped from the newest end of what was
// requeued, since the buffer may have filled meanwhile.
func (b *Buffer) Requeue(rs []Result) {
	b.mu.Lock()
	defer b.mu.Unlock()
	merged := make([]Result, 0, len(rs)+len(b.items))
	merged = append(merged, rs...)
	merged = append(merged, b.items...)
	if over := len(merged) - b.max; over > 0 {
		b.dropped += int64(over)
		merged = merged[over:]
	}
	b.items = merged
}

// Len is the number of buffered results.
func (b *Buffer) Len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.items)
}

// Dropped is the total number of results lost to the cap.
func (b *Buffer) Dropped() int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.dropped
}

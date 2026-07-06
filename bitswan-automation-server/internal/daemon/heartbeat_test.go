package daemon

import (
	"sync"
	"testing"
	"time"
)

// When the stream is idle past the threshold, streamHeartbeat keeps emitting
// ticks (with a monotonically non-decreasing elapsed) until stop is closed.
func TestStreamHeartbeat_EmitsWhenIdle(t *testing.T) {
	var mu sync.Mutex
	var count int
	var lastElapsed time.Duration
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		streamHeartbeat(stop, 2*time.Millisecond, time.Millisecond,
			func() time.Duration { return time.Hour }, // always "idle"
			func(elapsed time.Duration) {
				mu.Lock()
				count++
				lastElapsed = elapsed
				mu.Unlock()
			})
	}()
	time.Sleep(40 * time.Millisecond)
	close(stop)
	<-done // returns promptly on stop

	mu.Lock()
	defer mu.Unlock()
	if count == 0 {
		t.Fatal("expected heartbeat ticks while idle, got none")
	}
	if lastElapsed <= 0 {
		t.Fatalf("expected a positive elapsed, got %v", lastElapsed)
	}
}

// When the stream is never idle enough, streamHeartbeat emits nothing.
func TestStreamHeartbeat_SilentWhenActive(t *testing.T) {
	var mu sync.Mutex
	var count int
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		streamHeartbeat(stop, 2*time.Millisecond, time.Hour, // threshold never reached
			func() time.Duration { return 0 }, // never idle
			func(time.Duration) {
				mu.Lock()
				count++
				mu.Unlock()
			})
	}()
	time.Sleep(30 * time.Millisecond)
	close(stop)
	<-done

	mu.Lock()
	defer mu.Unlock()
	if count != 0 {
		t.Fatalf("expected no heartbeat while active, got %d", count)
	}
}

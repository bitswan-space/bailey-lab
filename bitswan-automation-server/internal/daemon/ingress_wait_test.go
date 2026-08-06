package daemon

import (
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The gate exists to stop single-shot AOC calls firing before our own Traefik
// serves anything. Two behaviours are load-bearing: it must actually retry (one
// probe is what the old code effectively did), and a timeout must be reported
// rather than swallowed — callers decide whether to continue, and the boot path
// deliberately continues.

func withProbe(t *testing.T, probe func(string) error) {
	t.Helper()
	saved := ingressProbe
	ingressProbe = probe
	t.Cleanup(func() { ingressProbe = saved })
}

// fastPoll shortens the retry interval so a test costs milliseconds.
func fastPoll(t *testing.T) {
	t.Helper()
	saved := ingressWaitPoll
	ingressWaitPoll = time.Millisecond
	t.Cleanup(func() { ingressWaitPoll = saved })
}

func TestWaitForIngressReturnsAsSoonAsItServes(t *testing.T) {
	var calls int32
	withProbe(t, func(string) error {
		atomic.AddInt32(&calls, 1)
		return nil
	})
	if err := waitForIngress("bailey.example.com", time.Second); err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("probe called %d times, want 1", got)
	}
}

func TestWaitForIngressKeepsTryingUntilItComesUp(t *testing.T) {
	// A cold Traefik container refuses connections for a moment; the whole point
	// of the helper is to survive that rather than give up on the first refusal.
	var calls int32
	withProbe(t, func(string) error {
		if atomic.AddInt32(&calls, 1) < 3 {
			return fmt.Errorf("connection refused")
		}
		return nil
	})

	fastPoll(t)

	if err := waitForIngress("bailey.example.com", 5*time.Second); err != nil {
		t.Fatal(err)
	}
	if got := atomic.LoadInt32(&calls); got != 3 {
		t.Errorf("probe called %d times, want 3", got)
	}
}

func TestWaitForIngressReportsATimeoutWithTheLastError(t *testing.T) {
	withProbe(t, func(string) error { return fmt.Errorf("connection refused") })
	fastPoll(t)

	err := waitForIngress("bailey.example.com", 10*time.Millisecond)
	if err == nil {
		t.Fatal("expected a timeout error")
	}
	// The hostname and the underlying cause both matter when reading a boot log.
	for _, want := range []string{"bailey.example.com", "connection refused"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error should mention %q: %v", want, err)
		}
	}
}

func TestWaitForIngressWithoutAHostnameIsAnError(t *testing.T) {
	if err := waitForIngress("", time.Second); err == nil {
		t.Error("an empty hostname should not silently succeed")
	}
}

func TestWaitForOwnIngressSkipsWhenNoDomainIsConfigured(t *testing.T) {
	// A server with no domain has no ingress to wait for, and the steps behind
	// the gate are no-ops there too — so this must not stall a bare server's boot.
	t.Setenv("HOME", t.TempDir())
	withProbe(t, func(string) error {
		t.Error("probe must not run without a configured domain")
		return nil
	})
	s := &Server{}
	if err := s.waitForOwnIngress(time.Second); err != nil {
		t.Errorf("expected a clean no-op, got %v", err)
	}
}

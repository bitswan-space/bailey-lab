package main

import (
	"context"
	"errors"
	"net"
	"strconv"
	"testing"
	"time"
)

func TestIsPublicIP(t *testing.T) {
	cases := []struct {
		ip   string
		want bool
	}{
		// The rebinding targets from #131 — all must be rejected.
		{"169.254.169.254", false}, // cloud metadata (IPv4 link-local)
		{"127.0.0.1", false},       // loopback
		{"127.8.8.8", false},       // any 127/8
		{"10.0.0.1", false},        // RFC1918
		{"172.16.0.1", false},      // RFC1918
		{"172.31.255.255", false},  // RFC1918 upper edge
		{"192.168.1.1", false},     // RFC1918
		{"::1", false},             // IPv6 loopback
		{"fe80::1", false},         // IPv6 link-local
		{"fc00::1", false},         // IPv6 ULA fc00::/7
		{"fd00::abcd", false},      // IPv6 ULA fd00::/8
		{"0.0.0.0", false},         // unspecified
		{"::", false},              // IPv6 unspecified
		{"224.0.0.251", false},     // IPv4 multicast
		{"ff02::1", false},         // IPv6 multicast
		// IPv4-mapped IPv6 spellings must be judged as their embedded IPv4.
		{"::ffff:10.0.0.1", false},
		{"::ffff:169.254.169.254", false},
		{"::ffff:127.0.0.1", false},
		// Remaining IPv4 special-purpose blocks.
		{"100.64.0.1", false},       // CGNAT 100.64.0.0/10
		{"192.0.0.170", false},      // 192.0.0.0/24
		{"198.18.0.1", false},       // benchmarking 198.18.0.0/15
		{"198.19.255.255", false},   // benchmarking upper half
		{"255.255.255.255", false},  // broadcast
		// Legitimate public addresses must stay reachable.
		{"93.184.216.34", true},         // example.com
		{"8.8.8.8", true},               // public DNS
		{"172.32.0.1", true},            // just past RFC1918 172.16/12
		{"100.128.0.1", true},           // just past CGNAT /10
		{"2606:4700:4700::1111", true},  // public IPv6
		{"::ffff:8.8.8.8", true},        // mapped public IPv4 is fine
	}
	for _, c := range cases {
		ip := net.ParseIP(c.ip)
		if ip == nil {
			t.Fatalf("bad test IP %q", c.ip)
		}
		if got := isPublicIP(ip); got != c.want {
			t.Errorf("isPublicIP(%s) = %v, want %v", c.ip, got, c.want)
		}
	}
	if isPublicIP(nil) {
		t.Error("isPublicIP(nil) = true, want false")
	}
}

// withFakeResolver swaps the package resolver for the test and restores it.
// Returns a counter of how many lookups were performed.
func withFakeResolver(t *testing.T, answers func(call int) []net.IP) *int {
	t.Helper()
	calls := 0
	orig := lookupIP
	lookupIP = func(ctx context.Context, host string) ([]net.IP, error) {
		calls++
		return answers(calls), nil
	}
	t.Cleanup(func() { lookupIP = orig })
	return &calls
}

func TestDialPinnedRejectsNonPublicResolution(t *testing.T) {
	for _, target := range []string{
		"169.254.169.254", "127.0.0.1", "10.1.2.3", "192.168.0.10",
		"::1", "fe80::1", "fc00::1", "::ffff:10.0.0.1",
	} {
		ip := net.ParseIP(target)
		withFakeResolver(t, func(int) []net.IP { return []net.IP{ip} })
		_, err := dialPinned("rebind.attacker.example", "443", true, time.Second)
		if !errors.Is(err, errNonPublic) {
			t.Errorf("host resolving to %s: err = %v, want errNonPublic", target, err)
		}
	}
}

func TestDialPinnedRejectsNonPublicIPLiteral(t *testing.T) {
	calls := withFakeResolver(t, func(int) []net.IP { return nil })
	_, err := dialPinned("169.254.169.254", "80", true, time.Second)
	if !errors.Is(err, errNonPublic) {
		t.Fatalf("err = %v, want errNonPublic", err)
	}
	if *calls != 0 {
		t.Errorf("IP-literal host hit the resolver %d times, want 0", *calls)
	}
}

func TestDialPinnedAllowsPublicResolution(t *testing.T) {
	// All answers public → the vetting must pass and dialPinned must attempt a
	// real dial. TEST-NET-1 with a tiny timeout: any outcome other than
	// errNonPublic proves the vet allowed it through to the dial stage.
	withFakeResolver(t, func(int) []net.IP { return []net.IP{net.ParseIP("192.0.2.1")} })
	_, err := dialPinned("public.example", "443", true, 50*time.Millisecond)
	if errors.Is(err, errNonPublic) {
		t.Fatalf("public resolution was rejected as non-public: %v", err)
	}
}

// TestDialPinnedPinsVettedIP proves resolve-once pinning: the resolver answers
// with the test listener's address on the first call and would answer with a
// different address on any later call. The dialed connection must land on the
// first-resolved (vetted) address, and the resolver must have been consulted
// exactly once — a second resolution at dial time (the rebinding window) must
// never happen.
func TestDialPinnedPinsVettedIP(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	addr := ln.Addr().(*net.TCPAddr)

	calls := withFakeResolver(t, func(call int) []net.IP {
		if call == 1 {
			return []net.IP{addr.IP}
		}
		return []net.IP{net.ParseIP("203.0.113.9")} // rebound answer — must never be used
	})

	// requirePublic=false (monitor-mode path) so the loopback listener is a
	// permitted destination; the pinning mechanics are identical in both modes.
	conn, err := dialPinned("pin.example", strconv.Itoa(addr.Port), false, 2*time.Second)
	if err != nil {
		t.Fatalf("dialPinned: %v", err)
	}
	defer conn.Close()

	if *calls != 1 {
		t.Errorf("resolver consulted %d times, want exactly 1 (resolve-once pinning)", *calls)
	}
	got := conn.RemoteAddr().(*net.TCPAddr)
	if !got.IP.Equal(addr.IP) || got.Port != addr.Port {
		t.Errorf("dialed %v, want the vetted address %v", got, addr)
	}
}

// In enforce mode a name whose addresses are a mix of public and non-public
// must only ever be dialed at the public ones. 192.0.2.x (TEST-NET-1) is
// unroutable, so the dial itself fails — but failing with a network error
// (not errNonPublic) proves the private answer was filtered out rather than
// dialed or fatal.
func TestDialPinnedFiltersMixedAnswers(t *testing.T) {
	withFakeResolver(t, func(int) []net.IP {
		return []net.IP{net.ParseIP("10.0.0.1"), net.ParseIP("192.0.2.1")}
	})
	_, err := dialPinned("mixed.example", "443", true, 50*time.Millisecond)
	if err == nil {
		t.Fatal("expected a dial error to unroutable TEST-NET-1")
	}
	if errors.Is(err, errNonPublic) {
		t.Fatalf("mixed public/private answers rejected outright: %v", err)
	}
}

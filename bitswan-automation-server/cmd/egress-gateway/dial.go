package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"time"
)

// This file closes the DNS-rebinding / confused-deputy SSRF hole (#131): the
// allow-list is matched against the SNI/Host *string*, so a tenant who
// allow-lists a domain they control can point its DNS (short TTL) at the cloud
// metadata IP or an RFC1918 address and have this gateway — whose uid is
// exempt from the iptables egress rules — connect there on their behalf.
// The fix is twofold:
//
//  1. after resolving the allowed name, reject any non-public destination
//     (loopback, link-local incl. 169.254.169.254, RFC1918, ULA, multicast,
//     unspecified, and their IPv4-mapped-IPv6 spellings), and
//  2. PIN the connection to the exact IP that was vetted — resolve once,
//     check that IP, dial that IP. Never hand the hostname back to the OS
//     resolver for the dial, where a second lookup could return a different
//     (internal) address.

// errNonPublic marks a dial refused because every vetted address was
// non-public. Callers use it to distinguish a policy rejection (log it as a
// blocked attempt) from an ordinary network/DNS failure (stay quiet, as
// before).
var errNonPublic = errors.New("resolves only to non-public addresses")

// lookupIP resolves a hostname to its IP addresses. A package variable so
// unit tests can substitute a fake resolver and prove both the filtering and
// the resolve-once pinning behavior.
var lookupIP = func(ctx context.Context, host string) ([]net.IP, error) {
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	ips := make([]net.IP, 0, len(addrs))
	for _, a := range addrs {
		ips = append(ips, a.IP)
	}
	return ips, nil
}

// isPublicIP reports whether ip is a publicly routable unicast address — the
// only kind the gateway may proxy to in enforce mode. Everything a rebinding
// attacker would aim at is excluded: loopback, link-local (the cloud metadata
// service lives on 169.254.169.254), RFC1918 and IPv6 ULA (fc00::/7, both
// covered by net.IP.IsPrivate), unspecified, multicast, plus the remaining
// IPv4 special-purpose blocks (0.0.0.0/8, CGNAT 100.64.0.0/10, 192.0.0.0/24,
// benchmarking 198.18.0.0/15, broadcast). IPv4-mapped IPv6 (::ffff:a.b.c.d)
// is unmapped first so it is judged as its embedded IPv4 address.
func isPublicIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if v4 := ip.To4(); v4 != nil {
		ip = v4 // unmap ::ffff:a.b.c.d → a.b.c.d
	}
	if ip.IsUnspecified() || ip.IsLoopback() || ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast() {
		return false
	}
	if v4 := ip.To4(); v4 != nil {
		switch {
		case v4[0] == 0: // 0.0.0.0/8 "this network"
			return false
		case v4[0] == 100 && v4[1]&0xc0 == 64: // 100.64.0.0/10 CGNAT
			return false
		case v4[0] == 192 && v4[1] == 0 && v4[2] == 0: // 192.0.0.0/24 IETF protocol assignments
			return false
		case v4[0] == 198 && v4[1]&0xfe == 18: // 198.18.0.0/15 benchmarking
			return false
		case v4[0] == 255 && v4[1] == 255 && v4[2] == 255 && v4[3] == 255: // broadcast
			return false
		}
	}
	return true
}

// dialPinned resolves host exactly once, optionally filters the answers to
// public addresses, and dials the vetted IPs directly (first success wins).
// Because the dial target is the already-checked IP literal — never the
// hostname — a second DNS resolution can never redirect the connection
// (rebinding-proof). A host that is itself an IP literal is vetted as-is with
// no DNS involved. requirePublic is false in monitor mode, which by contract
// lets everything through; the dial is still pinned there for consistency.
func dialPinned(host, port string, requirePublic bool, timeout time.Duration) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	h := normalizeHost(host)
	var ips []net.IP
	if ip := net.ParseIP(h); ip != nil {
		ips = []net.IP{ip}
	} else {
		var err error
		ips, err = lookupIP(ctx, h)
		if err != nil {
			return nil, err
		}
	}

	vetted := ips
	if requirePublic {
		vetted = vetted[:0:0]
		for _, ip := range ips {
			if isPublicIP(ip) {
				vetted = append(vetted, ip)
			}
		}
		if len(vetted) == 0 {
			return nil, fmt.Errorf("%s (%v): %w", h, ips, errNonPublic)
		}
	}
	if len(vetted) == 0 {
		return nil, fmt.Errorf("%s: no addresses", h)
	}

	// Spread the deadline across the addresses like net.Dial does with a
	// hostname (each attempt gets remaining/attempts-left): a host whose first
	// address is unreachable (e.g. IPv6 from a v4-only network) must still
	// fall back to its later addresses within the overall timeout, exactly as
	// the pre-pinning hostname dial did.
	d := &net.Dialer{}
	deadline, _ := ctx.Deadline()
	var lastErr error
	for i, ip := range vetted {
		attemptCtx, cancel := context.WithDeadline(ctx,
			deadline.Add(-time.Until(deadline)*time.Duration(len(vetted)-1-i)/time.Duration(len(vetted)-i)))
		conn, err := d.DialContext(attemptCtx, "tcp", net.JoinHostPort(ip.String(), port))
		cancel()
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

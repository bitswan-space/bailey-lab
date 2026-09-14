// Command egress-gateway is the Bitswan per-BP transparent egress firewall.
//
// BP containers share the netns OWNER's network namespace (network_mode:
// service:<gw>) with NET_ADMIN/NET_RAW dropped. The owner (entrypoint.sh)
// points that namespace's DEFAULT ROUTE and its /etc/resolv.conf at this proxy
// container, which sits in its own namespace on the stage network. So every
// packet a worker sends to a non-local destination — ANY TCP port, not just
// :80/:443 — arrives here, where our own PREROUTING REDIRECT funnels all of it
// onto the catch-all listener (:18000) and SO_ORIGINAL_DST tells us the ip:port
// the worker actually dialed. The proxy recovers the destination HOST (TLS SNI
// for :443, HTTP Host for :80, and for every other port the name the worker
// resolved through our DNS forwarder — see dnscache.go), checks the
// allow-list, and in ENFORCE mode blocks anything unlisted; in MONITOR mode it
// allows everything but logs unlisted hosts. Blocked/observed hosts are
// appended to the attempts log for the dashboard's "Needs review" queue, with
// the port they were dialed on.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Listener ports. Deliberately HIGH/uncommon: nothing else in the proxy
// container listens, but they must never collide with a REDIRECTed
// destination port either (a worker dialing example.com:18000 would otherwise
// be indistinguishable from the funnel itself).
const (
	catchAllPort = ":18000" // every TCP port, via the owner's default route + our REDIRECT
	tlsPort      = ":18443" // legacy DNAT target for :443 (kept for compatibility)
	httpPort     = ":18080" // legacy DNAT target for :80 (kept for compatibility)
	dnsPort      = ":18053" // the worker's resolver (REDIRECTed from :53)
	healthPort   = ":18077"
)

func main() {
	mode := os.Getenv("BITSWAN_FW_MODE") // "monitor" | "enforce"
	if mode != "enforce" {
		mode = "monitor"
	}
	allow := NewAllowList(splitCSV(os.Getenv("BITSWAN_FW_ALLOW")))
	gw := &gateway{
		mode:     mode,
		allow:    allow,
		attempts: os.Getenv("BITSWAN_FW_ATTEMPTS"), // JSONL path on a shared volume
		dns:      newDNSCache(),
	}
	log.Printf("egress-gateway: mode=%s allow=%q", mode, os.Getenv("BITSWAN_FW_ALLOW"))

	// Bind the FILTER ports FIRST and only then the health port, so the health
	// signal can never be observable before the redirect targets are listening.
	// The netns owner installs its rules (and the worker starts) only once this
	// container is healthy; if :18077 answered before :18000 was bound, the
	// worker's first dial could be REDIRECTed to a not-yet-listening port →
	// connection refused (the exact startup race the healthcheck exists to
	// prevent). net.Listen completing means the socket is accepting
	// connections, so binding health last makes "healthy ⇒ filter ports up" a
	// real invariant, not a scheduling accident.
	tlsLn := listen(tlsPort)
	httpLn := listen(httpPort)
	anyLn := listen(catchAllPort)
	go acceptLoop(tlsLn, func(c net.Conn) { go gw.handleTLS(c) })
	go acceptLoop(httpLn, func(c net.Conn) { go gw.handleHTTP(c) })
	go acceptLoop(anyLn, func(c net.Conn) { go gw.handleAny(c) })
	// The worker's resolver. Must be up before we report healthy too: the owner
	// rewrites the worker's resolv.conf to point here as soon as we are healthy,
	// and a worker whose first lookup hits a dead resolver fails its first
	// outbound call (and, worse, never gets its destination name recorded).
	go serveDNS(gw.dns, dnsPort, upstreamResolver())

	// Dedicated liveness port. Container healthchecks probe THIS, never the
	// filter ports — a bare TCP connect to :18443 (e.g. `nc -z`) would otherwise
	// read no ClientHello/Host and get logged as a "(no-sni)" blocked attempt,
	// polluting the "Needs review" feed every few seconds. Accept and
	// immediately close; it filters nothing.
	healthLn := listen(healthPort)
	acceptLoop(healthLn, func(c net.Conn) { c.Close() })
}

// listen binds a TCP listener, fatally exiting if the bind fails. Returning the
// established listener (rather than spawning the accept loop internally) lets
// main() order binds deterministically — see the filter-before-health ordering.
func listen(addr string) net.Listener {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("listen %s: %v", addr, err)
	}
	log.Printf("listening on %s", addr)
	return ln
}

func acceptLoop(ln net.Listener, handle func(net.Conn)) {
	for {
		c, err := ln.Accept()
		if err != nil {
			continue
		}
		handle(c)
	}
}

func splitCSV(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

type gateway struct {
	mode     string
	allow    *AllowList
	attempts string
	dns      *dnsCache
	mu       sync.Mutex
}

// decide applies the allow-list + mode. Returns whether to proceed and logs the
// attempt when the host is unlisted (blocked in enforce, observed in monitor).
func (g *gateway) decide(host, proto string, port int) bool {
	_, ok := g.decideNames([]string{host}, host, proto, port)
	return ok
}

// decideNames is decide() for a destination known by zero or more names (the
// ones the worker resolved to the IP it dialed, most recent first) plus a
// fallback label (the IP literal) used when no name is known. The connection
// is allowed if ANY of the names is allow-listed — they all denote the very
// same server the worker is about to talk to. The host returned is the one
// the decision (and the attempts log) is attributed to.
func (g *gateway) decideNames(names []string, fallback, proto string, port int) (host string, ok bool) {
	for _, n := range names {
		if g.allow.Allowed(n) {
			return n, true
		}
	}
	if g.allow.Allowed(fallback) {
		return fallback, true // an allow-listed IP literal
	}
	host = fallback
	if len(names) > 0 {
		host = names[0]
	}
	allowed := g.mode == "monitor" // monitor lets it through but still logs
	g.logAttempt(host, proto, port, allowed)
	return host, allowed
}

func (g *gateway) logAttempt(host, proto string, port int, allowed bool) {
	decision := "blocked"
	if allowed {
		decision = "observed"
	}
	log.Printf("%s %s %s:%d", decision, proto, host, port)
	if g.attempts == "" {
		return
	}
	line, _ := json.Marshal(map[string]any{
		"host": host, "port": port, "proto": proto, "decision": decision,
		"mode": g.mode, "at": time.Now().UTC().Format(time.RFC3339),
	})
	g.mu.Lock()
	defer g.mu.Unlock()
	f, err := os.OpenFile(g.attempts, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	f.Write(append(line, '\n'))
}

// dialUpstream connects to an allow-listed host with the destination IP
// vetted and pinned (see dial.go): the name is resolved once, non-public
// addresses are rejected in enforce mode, and the connection goes to the
// exact IP that passed the check. The allow-list alone is not enough — it
// matches the *name*, and a tenant-controlled name can be re-pointed at the
// cloud metadata IP or RFC1918 space between check and dial (#131). A
// non-public rejection is logged as a blocked attempt; plain network/DNS
// failures stay silent as before.
func (g *gateway) dialUpstream(host, port, proto string) (net.Conn, error) {
	conn, err := dialPinned(host, port, g.mode == "enforce", 10*time.Second)
	if err != nil && errors.Is(err, errNonPublic) {
		p, _ := strconv.Atoi(port)
		g.logAttempt(host, proto, p, false)
	}
	return conn, err
}

// handleAny is the catch-all: a connection the worker's default route brought
// to us and our REDIRECT funneled onto :18000. Recover the destination it was
// really dialing and hand it to the per-protocol path — the SAME paths the
// legacy per-port DNAT listeners use, so :443/:80 behave exactly as before,
// and everything else goes through handleRaw.
func (g *gateway) handleAny(c net.Conn) {
	ip, port, ok := originalDst(c)
	if !ok {
		c.Close()
		return
	}
	// A connection aimed at THIS container (a direct probe of the funnel port,
	// or anything else that was never REDIRECTed) has no upstream: proxying it
	// would dial ourselves in a loop. Drop silently — it is infrastructure
	// noise, not tenant egress, and must not pollute "Needs review".
	if ip.IsLoopback() || ip.Equal(localIP(c)) {
		c.Close()
		return
	}
	switch port {
	case 443:
		g.handleTLS(c)
	case 80:
		g.handleHTTP(c)
	default:
		g.handleRaw(c, ip, port)
	}
}

// handleRaw proxies a connection on a port that carries no in-band hostname.
// Identity comes from the DNS forwarder's notes: the name(s) the worker
// resolved to this IP. Unlike the TLS/HTTP paths we never re-resolve — the
// upstream is the exact ip:port the worker dialed, which is both what it
// intended and rebinding-proof by construction. Enforce mode still refuses
// non-public destinations (an allow-listed name pointed at RFC1918 or the
// cloud metadata IP is the #131 SSRF shape), logging the refusal as blocked.
func (g *gateway) handleRaw(c net.Conn, ip net.IP, port int) {
	defer c.Close()
	names := g.dns.Names(ip)
	host, ok := g.decideNames(names, ip.String(), "tcp", port)
	if !ok {
		return
	}
	if g.mode == "enforce" && !isPublicIP(ip) {
		g.logAttempt(host, "tcp", port, false)
		return
	}
	upstream, err := net.DialTimeout("tcp", net.JoinHostPort(ip.String(), strconv.Itoa(port)), 10*time.Second)
	if err != nil {
		return
	}
	defer upstream.Close()
	splice(c, upstream)
}

// handleTLS peeks the ClientHello SNI, then splices to <sni>:443.
func (g *gateway) handleTLS(c net.Conn) {
	defer c.Close()
	c.SetReadDeadline(time.Now().Add(10 * time.Second))
	hello, sni, err := readClientHelloSNI(c)
	c.SetReadDeadline(time.Time{})
	if err != nil || sni == "" {
		g.logAttempt("(no-sni)", "tls", 443, false)
		return // no SNI → can't allow-list → deny
	}
	if !g.decide(sni, "tls", 443) {
		return
	}
	upstream, err := g.dialUpstream(sni, "443", "tls")
	if err != nil {
		return
	}
	defer upstream.Close()
	upstream.Write(hello) // replay the buffered ClientHello
	splice(c, upstream)
}

// handleHTTP reads the request to get Host, then splices to <host>:80.
func (g *gateway) handleHTTP(c net.Conn) {
	defer c.Close()
	c.SetReadDeadline(time.Now().Add(10 * time.Second))
	br := bufio.NewReader(c)
	req, err := http.ReadRequest(br)
	c.SetReadDeadline(time.Time{})
	if err != nil {
		return
	}
	host := req.Host
	if host == "" {
		g.logAttempt("(no-host)", "http", 80, false)
		return
	}
	if !g.decide(host, "http", 80) {
		return
	}
	upstream, err := g.dialUpstream(host, "80", "http")
	if err != nil {
		return
	}
	defer upstream.Close()
	req.Write(upstream)   // replay the parsed request
	io.Copy(upstream, br) // any buffered/pipelined bytes
	splice(c, upstream)
}

func splice(a, b net.Conn) {
	done := make(chan struct{}, 2)
	go func() { io.Copy(a, b); done <- struct{}{} }()
	go func() { io.Copy(b, a); done <- struct{}{} }()
	<-done
}

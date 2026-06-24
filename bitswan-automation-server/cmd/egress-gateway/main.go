// Command egress-gateway is the Bitswan per-BP transparent egress firewall.
//
// BP containers share this container's network namespace
// (network_mode: service:<gateway>) and have NET_ADMIN/NET_RAW dropped, so the
// iptables rules installed here (by entrypoint.sh, exempting only this proxy's
// uid) intercept ALL of their outbound TCP :80/:443 and redirect it to this
// proxy — and root inside a BP container cannot alter the rules. The proxy
// extracts the destination host (TLS SNI for :443, HTTP Host for :80), checks
// the allow-list, and in ENFORCE mode blocks anything unlisted; in MONITOR mode
// it allows everything but logs unlisted hosts. Blocked/observed hosts are
// appended to the attempts log for the dashboard's "Needs review" queue.
package main

import (
	"bufio"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

func main() {
	mode := os.Getenv("BITSWAN_FW_MODE") // "monitor" | "enforce"
	if mode != "enforce" {
		mode = "monitor"
	}
	allow := NewAllowList(splitCSV(os.Getenv("BITSWAN_FW_ALLOW")))
	gw := &gateway{
		mode:    mode,
		allow:   allow,
		attempts: os.Getenv("BITSWAN_FW_ATTEMPTS"), // JSONL path on a shared volume
	}
	log.Printf("egress-gateway: mode=%s allow=%q", mode, os.Getenv("BITSWAN_FW_ALLOW"))

	// Bind the two FILTER ports FIRST and only then the health port, so the
	// health signal can never be observable before the redirect targets are
	// listening. A worker shares this netns and gates its start on the
	// container becoming healthy; if :18077 answered before :18443/:18080 were
	// bound, the worker could start and have its first HTTPS dial REDIRECTed by
	// iptables to a not-yet-listening :18443 → connection refused (the exact
	// startup race the healthcheck exists to prevent). net.Listen completing
	// means the socket is accepting connections, so binding health last makes
	// "healthy ⇒ filter ports up" a real invariant, not a scheduling accident.
	// These ports are deliberately HIGH/uncommon: the worker SHARES this netns,
	// so a filter port colliding with the app's own listen port (e.g. :8080)
	// would make the app fail to bind ("address already in use") and crashloop.
	tlsLn := listen(":18443")
	httpLn := listen(":18080")
	go acceptLoop(tlsLn, func(c net.Conn) { go gw.handleTLS(c) })
	go acceptLoop(httpLn, func(c net.Conn) { go gw.handleHTTP(c) })

	// Dedicated liveness port. Container healthchecks probe THIS, never the
	// :18443/:18080 proxy ports — a bare TCP connect to the proxy ports (e.g.
	// `nc -z`) would otherwise read no ClientHello/Host and get logged as a
	// "(no-sni)" blocked attempt, polluting the "Needs review" feed every few
	// seconds. Accept and immediately close; it filters nothing.
	healthLn := listen(":18077")
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
	mu       sync.Mutex
}

// decide applies the allow-list + mode. Returns whether to proceed and logs the
// attempt when the host is unlisted (blocked in enforce, observed in monitor).
func (g *gateway) decide(host, proto string) bool {
	if g.allow.Allowed(host) {
		return true
	}
	allowed := g.mode == "monitor" // monitor lets it through but still logs
	g.logAttempt(host, proto, allowed)
	return allowed
}

func (g *gateway) logAttempt(host, proto string, allowed bool) {
	decision := "blocked"
	if allowed {
		decision = "observed"
	}
	log.Printf("%s %s %s", decision, proto, host)
	if g.attempts == "" {
		return
	}
	line, _ := json.Marshal(map[string]any{
		"host": host, "proto": proto, "decision": decision,
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

// handleTLS peeks the ClientHello SNI, then splices to <sni>:443.
func (g *gateway) handleTLS(c net.Conn) {
	defer c.Close()
	c.SetReadDeadline(time.Now().Add(10 * time.Second))
	hello, sni, err := readClientHelloSNI(c)
	c.SetReadDeadline(time.Time{})
	if err != nil || sni == "" {
		g.logAttempt("(no-sni)", "tls", false)
		return // no SNI → can't allow-list → deny
	}
	if !g.decide(sni, "tls") {
		return
	}
	upstream, err := net.DialTimeout("tcp", net.JoinHostPort(sni, "443"), 10*time.Second)
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
		g.logAttempt("(no-host)", "http", false)
		return
	}
	if !g.decide(host, "http") {
		return
	}
	upstream, err := net.DialTimeout("tcp", net.JoinHostPort(normalizeHost(host), "80"), 10*time.Second)
	if err != nil {
		return
	}
	defer upstream.Close()
	req.Write(upstream)        // replay the parsed request
	io.Copy(upstream, br)      // any buffered/pipelined bytes
	splice(c, upstream)
}

func splice(a, b net.Conn) {
	done := make(chan struct{}, 2)
	go func() { io.Copy(a, b); done <- struct{}{} }()
	go func() { io.Copy(b, a); done <- struct{}{} }()
	<-done
}

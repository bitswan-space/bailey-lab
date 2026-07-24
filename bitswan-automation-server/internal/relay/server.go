package relay

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"strings"
	"sync"
	"time"
)

// Server is the AOC-side relay. It runs two listeners:
//
//   - the tunnel listener (TLS): Baileys dial in here, one persistent control
//     connection each plus a short-lived data connection per browser stream.
//   - the passthrough listener (plain TCP): Traefik forwards browser TLS streams
//     here by SNI with tls.passthrough, so the bytes arrive already encrypted
//     for the Bailey and we never hold a private key for the Bailey's domain.
//
// The relay keeps NO durable state and terminates NO TLS for proxied domains —
// it is a byte pump keyed by SNI.
type Server struct {
	// TunnelAddr is the public address Baileys dial (e.g. ":8443").
	TunnelAddr string
	// PassthroughAddr is where Traefik forwards browser streams (e.g. ":9443").
	PassthroughAddr string
	// TunnelTLS is the cert the relay presents on the tunnel listener. It is
	// self-signed; Baileys pin its fingerprint (advertised by the AOC), so the
	// AOC token in the register handshake is never exposed to a passive network
	// observer and cannot be MITM'd.
	TunnelTLS *tls.Config
	// ValidateToken confirms a Bailey's AOC token really belongs to the
	// subdomain it claims, by asking the AOC. The AOC endpoint it queries is the
	// relay's OWN configuration (see cmd/relay) — NEVER a URL taken from the
	// register frame, since a caller could otherwise nominate an authority that
	// rubber-stamps any subdomain and hijack another server's tunnel. Injected
	// so the binary that hosts the relay needn't hard-depend on the AOC client
	// wiring.
	ValidateToken func(token, subdomain string) error

	mu       sync.RWMutex
	tunnels  map[string]*tunnel  // subdomain -> live control channel
	pending  map[string]chan net.Conn // conn_id -> waiting browser stream handoff
}

// tunnel is one registered Bailey's control channel.
type tunnel struct {
	subdomain string
	conn      net.Conn
	enc       *bufio.Writer
	writeMu   sync.Mutex // serializes control frames to this Bailey
}

// NewServer builds a relay. Both addrs and TunnelTLS/ValidateToken are required.
func NewServer(tunnelAddr, passthroughAddr string, tunnelTLS *tls.Config, validate func(string, string) error) *Server {
	return &Server{
		TunnelAddr:      tunnelAddr,
		PassthroughAddr: passthroughAddr,
		TunnelTLS:       tunnelTLS,
		ValidateToken:   validate,
		tunnels:         map[string]*tunnel{},
		pending:         map[string]chan net.Conn{},
	}
}

// Run starts both listeners and blocks until ctx is cancelled or a listener
// fails to come up (fail loudly — a half-up relay silently drops traffic).
func (s *Server) Run(ctx context.Context) error {
	tunLn, err := tls.Listen("tcp", s.TunnelAddr, s.TunnelTLS)
	if err != nil {
		return fmt.Errorf("relay: tunnel listener on %s: %w", s.TunnelAddr, err)
	}
	defer tunLn.Close()

	ptLn, err := net.Listen("tcp", s.PassthroughAddr)
	if err != nil {
		return fmt.Errorf("relay: passthrough listener on %s: %w", s.PassthroughAddr, err)
	}
	defer ptLn.Close()

	log.Printf("relay: tunnel listener up on %s (TLS, fingerprint-pinned)", s.TunnelAddr)
	log.Printf("relay: passthrough listener up on %s (SNI-routed, no TLS termination)", s.PassthroughAddr)

	go func() {
		<-ctx.Done()
		tunLn.Close()
		ptLn.Close()
	}()

	errc := make(chan error, 2)
	go func() { errc <- s.acceptLoop(ctx, tunLn, s.handleTunnelConn) }()
	go func() { errc <- s.acceptLoop(ctx, ptLn, s.handlePassthroughConn) }()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-errc:
		return err
	}
}

func (s *Server) acceptLoop(ctx context.Context, ln net.Listener, handle func(net.Conn)) error {
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			// A closed listener is terminal — returning here (rather than
			// spinning) lets Run() surface it and shut the relay down.
			if errors.Is(err, net.ErrClosed) {
				return err
			}
			// Other accept errors are transient and shouldn't kill the relay.
			log.Printf("relay: accept on %s: %v", ln.Addr(), err)
			continue
		}
		go handle(conn)
	}
}

// handleTunnelConn reads the one opening frame on a Bailey-dialed connection and
// dispatches: register -> control channel, data -> browser-stream back-half.
func (s *Server) handleTunnelConn(conn net.Conn) {
	// A registering Bailey must complete its handshake promptly; a data dial
	// even faster. Clear the deadline once we know which it is.
	_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	br := bufio.NewReader(conn)
	f, err := readFrame(br)
	if err != nil {
		log.Printf("relay: reading opening frame: %v", err)
		conn.Close()
		return
	}
	_ = conn.SetReadDeadline(time.Time{})

	switch f.Type {
	case frameRegister:
		s.handleRegister(conn, br, f)
	case frameData:
		s.handleData(conn, br, f)
	default:
		_ = writeFrame(conn, frame{Type: frameError, Message: "expected register or data frame"})
		conn.Close()
	}
}

func (s *Server) handleRegister(conn net.Conn, br *bufio.Reader, f frame) {
	sub := strings.ToLower(strings.TrimSpace(f.Subdomain))
	if sub == "" || f.Token == "" {
		_ = writeFrame(conn, frame{Type: frameError, Message: "register requires token and subdomain"})
		conn.Close()
		return
	}
	// NB: f.AOCApiURL is deliberately NOT used here — the relay validates against
	// its own configured AOC (injected into ValidateToken), never a URL the
	// connecting client chose.
	if err := s.ValidateToken(f.Token, sub); err != nil {
		log.Printf("relay: rejecting registration for %q: %v", sub, err)
		_ = writeFrame(conn, frame{Type: frameError, Message: "token/subdomain validation failed"})
		conn.Close()
		return
	}

	t := &tunnel{subdomain: sub, conn: conn, enc: bufio.NewWriter(conn)}

	s.mu.Lock()
	if old := s.tunnels[sub]; old != nil {
		old.conn.Close() // a reconnecting Bailey supersedes its stale channel
	}
	s.tunnels[sub] = t
	s.mu.Unlock()

	if err := writeFrame(conn, frame{Type: frameAck}); err != nil {
		conn.Close()
		return
	}
	log.Printf("relay: registered tunnel for %q", sub)

	// Hold the control channel open. We only expect the Bailey to keep it alive;
	// any read that returns means the Bailey went away, so we retire the tunnel.
	// A background read lets us notice a dropped connection promptly.
	_, _ = io.Copy(io.Discard, br)

	s.mu.Lock()
	if s.tunnels[sub] == t {
		delete(s.tunnels, sub)
	}
	s.mu.Unlock()
	conn.Close()
	log.Printf("relay: tunnel for %q closed", sub)
}

func (s *Server) handleData(conn net.Conn, br *bufio.Reader, f frame) {
	if f.ConnID == "" {
		conn.Close()
		return
	}
	s.mu.Lock()
	ch := s.pending[f.ConnID]
	delete(s.pending, f.ConnID)
	s.mu.Unlock()
	if ch == nil {
		// No browser stream is waiting (timed out or duplicate) — drop it.
		conn.Close()
		return
	}
	// Hand this connection (with its buffered reader, in case the Bailey already
	// sent bytes) to the waiting passthrough handler.
	ch <- &bufferedConn{Conn: conn, r: br}
}

// handlePassthroughConn peeks the SNI off a browser TLS stream, finds the
// matching Bailey, asks it (over the control channel) to dial a data connection
// back, then splices the two — replaying the peeked ClientHello untouched.
func (s *Server) handlePassthroughConn(browser net.Conn) {
	// Peek exactly the ClientHello record to read its SNI without consuming it.
	// The deadline only guards against a client that connects but never sends a
	// hello; a well-behaved client's hello is already in the first packet, so
	// this returns immediately (no per-connection stall).
	br := bufio.NewReader(browser)
	_ = browser.SetReadDeadline(time.Now().Add(10 * time.Second))
	hello, err := peekClientHello(br)
	if err != nil {
		log.Printf("relay: passthrough read while peeking ClientHello: %v", err)
		browser.Close()
		return
	}
	sni, err := parseSNI(hello)
	if err != nil {
		log.Printf("relay: passthrough SNI parse: %v", err)
		browser.Close()
		return
	}
	_ = browser.SetReadDeadline(time.Time{})

	t := s.tunnelForSNI(sni)
	if t == nil {
		log.Printf("relay: no tunnel registered for SNI %q", sni)
		browser.Close()
		return
	}

	connID := newConnID()
	handoff := make(chan net.Conn, 1)
	s.mu.Lock()
	s.pending[connID] = handoff
	s.mu.Unlock()

	// Ask the Bailey to dial back.
	t.writeMu.Lock()
	err = writeFrame(t.conn, frame{Type: frameOpen, ConnID: connID, SNI: sni})
	t.writeMu.Unlock()
	if err != nil {
		s.mu.Lock()
		delete(s.pending, connID)
		s.mu.Unlock()
		browser.Close()
		return
	}

	// Wait for the Bailey's data connection.
	var back net.Conn
	select {
	case back = <-handoff:
	case <-time.After(15 * time.Second):
		s.mu.Lock()
		delete(s.pending, connID)
		s.mu.Unlock()
		log.Printf("relay: Bailey %q did not dial back for %s", t.subdomain, connID)
		browser.Close()
		return
	}

	splice(&bufferedConn{Conn: browser, r: br}, back)
}

// tunnelForSNI finds the Bailey whose subdomain owns this SNI. A server's SNI is
// a host UNDER its domain (bailey.<domain>, *.<domain>), so we match by suffix.
func (s *Server) tunnelForSNI(sni string) *tunnel {
	sni = strings.ToLower(strings.TrimSuffix(sni, "."))
	s.mu.RLock()
	defer s.mu.RUnlock()
	// Exact-domain and sub-of-domain match; longest registered subdomain wins.
	var best *tunnel
	for sub, t := range s.tunnels {
		if sni == sub || strings.HasSuffix(sni, "."+sub) {
			if best == nil || len(sub) > len(best.subdomain) {
				best = t
			}
		}
	}
	return best
}

// splice pumps bytes both ways until either side closes, then tears both down.
func splice(a, b net.Conn) {
	done := make(chan struct{}, 2)
	cp := func(dst, src net.Conn) {
		_, _ = io.Copy(dst, src)
		// Half-close the write side so the peer sees EOF, if supported.
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		}
		done <- struct{}{}
	}
	go cp(a, b)
	go cp(b, a)
	<-done
	<-done
	a.Close()
	b.Close()
}

func newConnID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// bufferedConn lets a peeked/partly-read connection behave like a plain net.Conn
// while still draining bytes already sitting in its bufio.Reader.
type bufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (b *bufferedConn) Read(p []byte) (int, error) { return b.r.Read(p) }

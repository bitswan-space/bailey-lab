package relay

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"fmt"
	"io"
	"math/big"
	"net"
	"testing"
	"time"
)

// selfSigned builds a throwaway leaf cert for host, returning the tls.Certificate
// and its DER (for fingerprint comparison).
func selfSigned(t *testing.T, host string) (tls.Certificate, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: host},
		DNSNames:     []string{host},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert := tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
	return cert, der
}

// startLocalTLS stands up a tiny TLS echo-ish server that answers HTTP-like so a
// client handshake completes and can read a body. Returns its addr + leaf DER.
func startLocalTLS(t *testing.T, host string) (string, []byte) {
	t.Helper()
	cert, der := selfSigned(t, host)
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{cert}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 1024)
				_, _ = c.Read(buf)
				_, _ = io.WriteString(c, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
			}(c)
		}
	}()
	return ln.Addr().String(), der
}

func TestParseSNI(t *testing.T) {
	// Build a real ClientHello by having the tls stack write one to a pipe.
	cliHello := make(chan []byte, 1)
	srv, cli := net.Pipe()
	go func() {
		buf := make([]byte, 4096)
		n, _ := srv.Read(buf)
		cliHello <- buf[:n]
		srv.Close()
	}()
	go func() {
		c := tls.Client(cli, &tls.Config{ServerName: "bailey.acme-prod.bswn.io", InsecureSkipVerify: true})
		_ = c.HandshakeContext(context.Background())
		cli.Close()
	}()
	hello := <-cliHello
	name, err := parseSNI(hello)
	if err != nil {
		t.Fatalf("parseSNI: %v", err)
	}
	if name != "bailey.acme-prod.bswn.io" {
		t.Fatalf("SNI = %q, want bailey.acme-prod.bswn.io", name)
	}
}

// TestEndToEndPassthrough is the whole point: a browser TLS handshake through
// the relay must see the LOCAL server's certificate, proving the relay never
// terminated TLS.
func TestEndToEndPassthrough(t *testing.T) {
	const domain = "acme-prod.bswn.io"
	const sni = "bailey.acme-prod.bswn.io"

	localAddr, localDER := startLocalTLS(t, sni)

	// Relay with its own pinned tunnel cert.
	relayCert, relayDER := selfSigned(t, "relay")
	relayFP := fmt.Sprintf("%x", sha256.Sum256(relayDER))
	srv := NewServer("127.0.0.1:0", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{relayCert}},
		func(_, token, sub string) error {
			if token != "good-token" || sub != domain {
				return fmt.Errorf("bad token/sub")
			}
			return nil
		})

	// Bind explicit ports so the client + browser know where to dial.
	tunLn, err := tls.Listen("tcp", "127.0.0.1:0", srv.TunnelTLS)
	if err != nil {
		t.Fatal(err)
	}
	ptLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv.TunnelAddr = tunLn.Addr().String()
	srv.PassthroughAddr = ptLn.Addr().String()
	go srv.acceptLoop(context.Background(), tunLn, srv.handleTunnelConn)
	go srv.acceptLoop(context.Background(), ptLn, srv.handlePassthroughConn)
	t.Cleanup(func() { tunLn.Close(); ptLn.Close() })

	// Bailey tunnel client.
	client := NewClient(ClientConfig{
		RelayAddr:        srv.TunnelAddr,
		RelayFingerprint: relayFP,
		AOCApiURL:        "http://unused",
		Token:            "good-token",
		Subdomain:        domain,
		LocalTarget:      localAddr,
	})
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go client.Run(ctx)

	// Give the control channel a moment to register (poll, don't fixed-sleep).
	if !waitForTunnel(srv, domain, 5*time.Second) {
		t.Fatal("tunnel never registered")
	}

	// The "browser": dial the passthrough port with SNI and complete a TLS
	// handshake. It must receive the LOCAL server's leaf.
	raw, err := net.DialTimeout("tcp", srv.PassthroughAddr, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	bconn := tls.Client(raw, &tls.Config{ServerName: sni, InsecureSkipVerify: true})
	if err := bconn.HandshakeContext(ctx); err != nil {
		t.Fatalf("browser handshake through relay: %v", err)
	}
	served := bconn.ConnectionState().PeerCertificates[0].Raw
	if fmt.Sprintf("%x", sha256.Sum256(served)) != fmt.Sprintf("%x", sha256.Sum256(localDER)) {
		t.Fatal("browser did NOT receive the local server's cert — relay terminated TLS")
	}

	// And a full request/response round-trip works.
	_, _ = io.WriteString(bconn, "GET / HTTP/1.1\r\nHost: "+sni+"\r\n\r\n")
	buf := make([]byte, 64)
	_ = bconn.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, err := bconn.Read(buf)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	if string(buf[:n])[:12] != "HTTP/1.1 200" {
		t.Fatalf("unexpected response: %q", buf[:n])
	}
}

func waitForTunnel(s *Server, sub string, within time.Duration) bool {
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		s.mu.RLock()
		_, ok := s.tunnels[sub]
		s.mu.RUnlock()
		if ok {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

func TestVerifyEndToEndTLSDetectsMITM(t *testing.T) {
	const sni = "bailey.acme-prod.bswn.io"
	// A server that presents a DIFFERENT cert than the one we claim is ours.
	otherAddr, _ := startLocalTLS(t, sni)
	_, ourDER := selfSigned(t, sni)

	err := VerifyEndToEndTLS(context.Background(), sni, otherAddr, ourDER)
	if err == nil {
		t.Fatal("expected MITM detection (served cert != our leaf), got nil")
	}
}

func TestVerifyEndToEndTLSAcceptsOwnCert(t *testing.T) {
	const sni = "bailey.acme-prod.bswn.io"
	cert, der := selfSigned(t, sni)
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{cert}})
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		tc := c.(*tls.Conn)
		_ = tc.Handshake()
		c.Close()
	}()
	if err := VerifyEndToEndTLS(context.Background(), sni, ln.Addr().String(), der); err != nil {
		t.Fatalf("expected self-check to pass with matching cert: %v", err)
	}
}

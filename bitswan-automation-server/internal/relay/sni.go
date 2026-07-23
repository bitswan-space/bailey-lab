// Package relay implements the AOC transparent reverse-proxy relay and its
// Bailey-side tunnel client.
//
// A Bailey behind NAT (or forced onto this path with `register --force-proxy`)
// cannot receive an inbound A record, so instead of the AOC pointing DNS at the
// server, the AOC points the server's wildcard record at THIS relay and the
// Bailey dials an outbound control connection to it. When a browser then hits
// `https://bailey.<domain>`, Traefik on the AOC box TCP-routes it (SNI,
// tls.passthrough — never decrypting) to the relay, which asks the matching
// Bailey to open a fresh data connection back and splices the two together. The
// browser's TLS is negotiated end-to-end with the Bailey's own certificate; the
// relay only ferries opaque bytes. The Bailey independently verifies this by
// fetching its own public URL and pinning the served leaf certificate to its
// own (see client.go) — if anything terminated TLS in the middle, that check
// fails loudly and the tunnel is torn down.
package relay

import (
	"bufio"
	"encoding/binary"
	"errors"
)

// peekClientHello returns the bytes of the initial TLS handshake record from br
// WITHOUT consuming them. It reads exactly the record framing (5-byte header →
// record length → the record) so it never blocks waiting for bytes the client
// won't send until it has seen a ServerHello. This is the whole ballgame for
// latency: peeking "one more than buffered" instead would stall every
// connection until the read deadline.
func peekClientHello(br *bufio.Reader) ([]byte, error) {
	hdr, err := br.Peek(5)
	if err != nil {
		return nil, err
	}
	if hdr[0] != 0x16 {
		return nil, errors.New("relay: first record is not a TLS handshake")
	}
	recLen := int(binary.BigEndian.Uint16(hdr[3:5]))
	return br.Peek(5 + recLen)
}

// errNotClientHello means the buffered bytes are not (yet) a TLS ClientHello we
// can read an SNI out of. Callers should read more bytes and retry.
var errNotClientHello = errors.New("relay: not a complete TLS ClientHello")

// parseSNI extracts the server_name (SNI) from a buffered TLS ClientHello
// WITHOUT consuming or terminating the connection. The relay needs the SNI to
// pick which Bailey tunnel a passthrough stream belongs to; the exact same
// bytes are then replayed to that Bailey so its TLS stack sees an untouched
// handshake. Returns errNotClientHello if buf doesn't yet hold a full hello.
//
// This is a deliberately minimal, allocation-light TLS-record/handshake walker
// — we only decode enough of the structure to reach extension 0x0000. It never
// interprets the crypto, so it can't be tricked into doing anything but reading
// a hostname or bailing out.
func parseSNI(buf []byte) (string, error) {
	// TLS record header: type(1) + version(2) + length(2).
	if len(buf) < 5 {
		return "", errNotClientHello
	}
	if buf[0] != 0x16 { // not a handshake record
		return "", errors.New("relay: first record is not a TLS handshake")
	}
	recLen := int(binary.BigEndian.Uint16(buf[3:5]))
	if len(buf) < 5+recLen {
		return "", errNotClientHello // record not fully buffered yet
	}
	hs := buf[5 : 5+recLen]

	// Handshake header: msg_type(1) + length(3).
	if len(hs) < 4 {
		return "", errNotClientHello
	}
	if hs[0] != 0x01 { // not a ClientHello
		return "", errors.New("relay: handshake is not a ClientHello")
	}
	hsLen := int(hs[1])<<16 | int(hs[2])<<8 | int(hs[3])
	body := hs[4:]
	if len(body) < hsLen {
		// ClientHello can legitimately span multiple records; we require it in
		// one buffered read, which is true for every real client.
		return "", errNotClientHello
	}
	body = body[:hsLen]

	p := 0
	// client_version(2) + random(32).
	if len(body) < p+34 {
		return "", errNotClientHello
	}
	p += 34
	// session_id: len(1) + data.
	if len(body) < p+1 {
		return "", errNotClientHello
	}
	sidLen := int(body[p])
	p += 1 + sidLen
	// cipher_suites: len(2) + data.
	if len(body) < p+2 {
		return "", errNotClientHello
	}
	csLen := int(binary.BigEndian.Uint16(body[p : p+2]))
	p += 2 + csLen
	// compression_methods: len(1) + data.
	if len(body) < p+1 {
		return "", errNotClientHello
	}
	cmLen := int(body[p])
	p += 1 + cmLen
	// extensions: len(2) + data.
	if len(body) < p+2 {
		return "", errNotClientHello
	}
	extTotal := int(binary.BigEndian.Uint16(body[p : p+2]))
	p += 2
	if len(body) < p+extTotal {
		return "", errNotClientHello
	}
	ext := body[p : p+extTotal]

	for len(ext) >= 4 {
		etype := binary.BigEndian.Uint16(ext[0:2])
		elen := int(binary.BigEndian.Uint16(ext[2:4]))
		if len(ext) < 4+elen {
			break
		}
		edata := ext[4 : 4+elen]
		if etype == 0x0000 { // server_name
			// server_name_list: len(2), then entries of type(1)+len(2)+name.
			if len(edata) < 2 {
				return "", errors.New("relay: malformed SNI extension")
			}
			list := edata[2:]
			for len(list) >= 3 {
				nameType := list[0]
				nameLen := int(binary.BigEndian.Uint16(list[1:3]))
				if len(list) < 3+nameLen {
					break
				}
				if nameType == 0x00 { // host_name
					return string(list[3 : 3+nameLen]), nil
				}
				list = list[3+nameLen:]
			}
			return "", errors.New("relay: SNI extension has no host_name")
		}
		ext = ext[4+elen:]
	}
	return "", errors.New("relay: ClientHello has no SNI extension")
}

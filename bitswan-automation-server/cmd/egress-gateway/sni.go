package main

import (
	"encoding/binary"
	"errors"
	"io"
)

// readClientHelloSNI reads exactly one TLS record (the ClientHello) from r,
// returns the raw bytes read (so the caller can replay them to the upstream)
// and the SNI server name. Errors if the first record isn't a ClientHello or
// has no SNI. Only the first record is inspected (a ClientHello split across
// records is treated as "no SNI" → denied, which is safe).
func readClientHelloSNI(r io.Reader) (raw []byte, sni string, err error) {
	hdr := make([]byte, 5)
	if _, err = io.ReadFull(r, hdr); err != nil {
		return nil, "", err
	}
	if hdr[0] != 0x16 { // not a TLS handshake record
		return hdr, "", errors.New("not a TLS handshake")
	}
	recLen := int(binary.BigEndian.Uint16(hdr[3:5]))
	if recLen <= 0 || recLen > 1<<16 {
		return hdr, "", errors.New("bad record length")
	}
	body := make([]byte, recLen)
	if _, err = io.ReadFull(r, body); err != nil {
		return append(hdr, body...), "", err
	}
	raw = append(hdr, body...)
	sni, perr := parseClientHelloSNI(body)
	return raw, sni, perr
}

// parseClientHelloSNI walks a TLS handshake message body to the SNI extension.
func parseClientHelloSNI(b []byte) (string, error) {
	// Handshake header: type(1) + length(3)
	if len(b) < 4 || b[0] != 0x01 {
		return "", errors.New("not a ClientHello")
	}
	p := b[4:]
	read := func(n int) ([]byte, bool) {
		if len(p) < n {
			return nil, false
		}
		v := p[:n]
		p = p[n:]
		return v, true
	}
	if _, ok := read(2 + 32); !ok { // client_version + random
		return "", errors.New("truncated")
	}
	if sid, ok := read(1); !ok { // session_id
		return "", errors.New("truncated")
	} else if _, ok := read(int(sid[0])); !ok {
		return "", errors.New("truncated")
	}
	cs, ok := read(2) // cipher_suites length
	if !ok {
		return "", errors.New("truncated")
	}
	if _, ok := read(int(binary.BigEndian.Uint16(cs))); !ok {
		return "", errors.New("truncated")
	}
	cm, ok := read(1) // compression_methods length
	if !ok {
		return "", errors.New("truncated")
	}
	if _, ok := read(int(cm[0])); !ok {
		return "", errors.New("truncated")
	}
	extTotal, ok := read(2) // extensions length
	if !ok {
		return "", errors.New("no extensions")
	}
	ext := p
	if len(ext) > int(binary.BigEndian.Uint16(extTotal)) {
		ext = ext[:binary.BigEndian.Uint16(extTotal)]
	}
	for len(ext) >= 4 {
		etype := binary.BigEndian.Uint16(ext[:2])
		elen := int(binary.BigEndian.Uint16(ext[2:4]))
		ext = ext[4:]
		if len(ext) < elen {
			break
		}
		data := ext[:elen]
		ext = ext[elen:]
		if etype != 0x0000 { // server_name
			continue
		}
		// server_name_list(2) then entries: type(1)=host_name, len(2), name
		if len(data) < 5 || data[2] != 0x00 {
			return "", errors.New("bad SNI ext")
		}
		nameLen := int(binary.BigEndian.Uint16(data[3:5]))
		if len(data) < 5+nameLen {
			return "", errors.New("bad SNI len")
		}
		return string(data[5 : 5+nameLen]), nil
	}
	return "", errors.New("no SNI extension")
}

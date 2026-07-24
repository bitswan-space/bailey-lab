package relay

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
)

// The tunnel uses a tiny newline-delimited JSON control protocol. Every
// connection a Bailey dials to the relay opens with exactly one frame:
//
//   - a "register" frame turns that connection into the Bailey's persistent
//     control channel; the relay pushes "open" frames down it when a browser
//     arrives.
//   - a "data" frame claims a connection as the back-half of a specific browser
//     stream the relay is holding open (matched by ConnID). After the relay
//     acks, both sides stop speaking JSON and the connection carries raw,
//     end-to-end-encrypted browser<->Bailey bytes.
//
// Keeping it newline-JSON (not a binary framing) makes the tunnel trivially
// debuggable with `nc` and immune to the struct-drift bugs a hand-rolled binary
// header invites.

// frameType enumerates the one-shot opening frame on every tunnel connection.
type frameType string

const (
	frameRegister frameType = "register" // Bailey -> relay: become a control channel
	frameData     frameType = "data"     // Bailey -> relay: back-half of a browser stream
	frameOpen     frameType = "open"     // relay -> Bailey: please dial a data connection
	frameAck      frameType = "ack"      // relay -> Bailey: handshake accepted
	frameError    frameType = "error"    // either direction: fatal, connection closes
)

// frame is the single JSON envelope for every control message. Fields are
// populated per Type; unused ones are omitted.
type frame struct {
	Type frameType `json:"type"`

	// register
	Token     string `json:"token,omitempty"`     // the Bailey's AOC access token
	AOCApiURL string `json:"aoc_api_url,omitempty"` // AOC base URL (informational only; the relay validates against its OWN configured AOC, never this client-supplied value)
	Subdomain string `json:"subdomain,omitempty"` // the server's *.bswn.io domain

	// open / data
	ConnID string `json:"conn_id,omitempty"` // correlates an "open" push to its "data" dial
	SNI    string `json:"sni,omitempty"`     // server name the browser asked for (informational)

	// error
	Message string `json:"message,omitempty"`
}

// writeFrame emits one newline-delimited JSON frame.
func writeFrame(w io.Writer, f frame) error {
	b, err := json.Marshal(f)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	_, err = w.Write(b)
	return err
}

// readFrame reads exactly one newline-delimited JSON frame from r. The caller
// owns r's buffering (a *bufio.Reader) so any bytes read past the newline —
// e.g. the raw browser stream that follows a "data" handshake — stay buffered
// and are not lost.
func readFrame(r *bufio.Reader) (frame, error) {
	line, err := r.ReadBytes('\n')
	if err != nil {
		return frame{}, err
	}
	var f frame
	if err := json.Unmarshal(line, &f); err != nil {
		return frame{}, fmt.Errorf("relay: malformed control frame: %w", err)
	}
	return f, nil
}

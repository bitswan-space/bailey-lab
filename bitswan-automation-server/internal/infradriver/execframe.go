package infradriver

import (
	"encoding/binary"
	"fmt"
	"io"
)

// writeExecFrame writes one [stream][len][payload] frame. Callers flush after.
func writeExecFrame(w io.Writer, stream byte, payload []byte) error {
	var hdr [5]byte
	hdr[0] = stream
	binary.BigEndian.PutUint32(hdr[1:], uint32(len(payload)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	if len(payload) > 0 {
		if _, err := w.Write(payload); err != nil {
			return err
		}
	}
	return nil
}

// readExecFrames reads the multiplexed exec stream, delivering stdout/stderr
// chunks to out and returning the exit code from the terminal exit frame. An
// error frame (or a transport error) is returned as an error.
func readExecFrames(r io.Reader, out func(stderr bool, chunk []byte)) (int, error) {
	var hdr [5]byte
	for {
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				return -1, fmt.Errorf("exec stream ended without an exit frame")
			}
			return -1, err
		}
		stream := hdr[0]
		n := binary.BigEndian.Uint32(hdr[1:])
		payload := make([]byte, n)
		if _, err := io.ReadFull(r, payload); err != nil {
			return -1, err
		}
		switch stream {
		case ExecStreamStdout:
			out(false, payload)
		case ExecStreamStderr:
			out(true, payload)
		case ExecStreamExit:
			if len(payload) != 4 {
				return -1, fmt.Errorf("malformed exit frame")
			}
			return int(int32(binary.BigEndian.Uint32(payload))), nil
		case ExecStreamError:
			return -1, fmt.Errorf("%s", payload)
		default:
			return -1, fmt.Errorf("unknown exec frame stream %d", stream)
		}
	}
}

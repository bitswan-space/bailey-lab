package backup

import (
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The restic encryption key is the server's crown jewels once backups include
// workspace secrets. It lives 0600 in the daemon's config volume, is
// downloadable only through admin-gated surfaces, and never reaches a workspace
// container.
//
// It is deliberately NEVER escrowed anywhere — not in S3, not in AOC. That
// means the key exists in exactly two places: this volume, and whatever copy
// the operator keeps. Losing both makes every backup permanently unreadable, so
// the daemon nags until an operator confirms they have saved it (see
// KeyAcknowledged) rather than quietly assuming a copy exists.

func keyPath() string { return filepath.Join(Dir(), "restic-key") }

// LoadKey returns the local key, or "" (no error) when none exists yet.
func LoadKey() (string, error) {
	data, err := os.ReadFile(keyPath())
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

// GenerateKey mints a new key (urlsafe, ~64 chars — same entropy class as
// gitops's token_urlsafe(48)).
func GenerateKey() (string, error) {
	raw := make([]byte, 48)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// SaveKey persists the key 0600 in the 0700 backup dir.
func SaveKey(key string) error {
	if err := ensureDir(); err != nil {
		return err
	}
	return os.WriteFile(keyPath(), []byte(key), 0o600)
}

// DeleteLocalKey removes the local key file (explicit admin action only).
func DeleteLocalKey() error {
	err := os.Remove(keyPath())
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// keyAcknowledgedPath marks that an operator has confirmed they saved a copy of
// the key off this server.
func keyAcknowledgedPath() string { return filepath.Join(Dir(), "key-acknowledged") }

// KeyAcknowledged reports whether the operator has confirmed saving the key.
// While false, every surface warns: with no escrow, an unsaved key means server
// recovery is impossible, and the failure is silent until the day it matters.
func KeyAcknowledged() bool {
	_, err := os.Stat(keyAcknowledgedPath())
	return err == nil
}

// AcknowledgeKey records that the key has been saved off-server.
func AcknowledgeKey() error {
	if err := ensureDir(); err != nil {
		return err
	}
	return os.WriteFile(keyAcknowledgedPath(), []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o600)
}

// UnsavedKeyWarning is the message shown while a key exists but has not been
// acknowledged, or "" when there is nothing to warn about.
func UnsavedKeyWarning() string {
	key, err := LoadKey()
	if err != nil || key == "" || KeyAcknowledged() {
		return ""
	}
	return "KEY NOT SAVED — this key is not stored anywhere else. If this server is lost " +
		"without a copy, every backup is permanently unreadable. Run `bitswan backup key show " +
		"--acknowledge` once you have stored it somewhere safe."
}

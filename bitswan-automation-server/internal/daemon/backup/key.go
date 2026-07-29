package backup

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The restic encryption key is the server's crown jewels once backups
// include workspace secrets: it lives 0600 in the daemon's config volume,
// is escrowed (mirrored) at AOC so a rebuilt server can recover it, and is
// downloadable only through admin-gated surfaces. It never reaches a
// workspace container.

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

// DeleteLocalKey removes the local key file (used only by explicit admin
// action; the mirrored copy is managed separately).
func DeleteLocalKey() error {
	err := os.Remove(keyPath())
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

var mirrorHTTP = &http.Client{Timeout: 30 * time.Second}

func (t *AOCTarget) mirrorRequest(ctx context.Context, method string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, t.KeyMirrorURL(), body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+t.Token)
	return mirrorHTTP.Do(req)
}

// MirrorKey escrows the key at AOC (PUT; also lazily creates the bucket).
func (t *AOCTarget) MirrorKey(ctx context.Context, key string) error {
	resp, err := t.mirrorRequest(ctx, http.MethodPut, strings.NewReader(key))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("key mirror PUT: unexpected status %s", resp.Status)
	}
	return nil
}

// FetchMirroredKey returns the escrowed key, or "" when none is mirrored.
func (t *AOCTarget) FetchMirroredKey(ctx context.Context) (string, error) {
	resp, err := t.mirrorRequest(ctx, http.MethodGet, nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return "", nil
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("key mirror GET: unexpected status %s", resp.Status)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

// KeyMirrored reports whether a key is escrowed at AOC.
func (t *AOCTarget) KeyMirrored(ctx context.Context) (bool, error) {
	key, err := t.FetchMirroredKey(ctx)
	if err != nil {
		return false, err
	}
	return key != "", nil
}

// DeleteMirroredKey removes the escrowed copy (explicit admin action; the
// console warns that a lost server then makes backups unrecoverable without
// a downloaded key).
func (t *AOCTarget) DeleteMirroredKey(ctx context.Context) error {
	resp, err := t.mirrorRequest(ctx, http.MethodDelete, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNotFound {
		return fmt.Errorf("key mirror DELETE: unexpected status %s", resp.Status)
	}
	return nil
}

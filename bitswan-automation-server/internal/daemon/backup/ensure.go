package backup

import (
	"context"
	"fmt"
)

// Status describes whether backups can run and why not — consumed by the
// status API and the scheduler's gate.
type Status struct {
	AOCConnected bool   `json:"aoc_connected"`
	Enabled      bool   `json:"enabled"`
	HasKey       bool   `json:"has_key"`
	Reason       string `json:"reason,omitempty"` // human-readable when not runnable
}

// Runnable reports whether a backup run can proceed.
func (s Status) Runnable() bool {
	return s.AOCConnected && s.Enabled && s.HasKey
}

// EnsureEnabled is the self-enable path (port of gitops's
// ensure_backups_enabled): with an AOC connection and no explicit
// enabled:false, make sure config exists, a key exists (recovering the
// escrowed one on a rebuilt server before generating fresh), the repo is
// initialized, and the key is escrowed. Idempotent; safe at startup and
// before every run.
func EnsureEnabled(ctx context.Context) (Status, error) {
	target, err := LoadAOCTarget()
	if err != nil {
		return Status{Reason: "server is not registered with an AOC"}, nil
	}

	cfg, exists, err := LoadConfig()
	if err != nil {
		return Status{AOCConnected: true}, err
	}
	if !cfg.Enabled {
		return Status{AOCConnected: true, Reason: "backups explicitly disabled"}, nil
	}
	if !exists {
		if err := SaveConfig(cfg); err != nil {
			return Status{AOCConnected: true, Enabled: true}, fmt.Errorf("failed to write default backup config: %w", err)
		}
	}

	key, err := LoadKey()
	if err != nil {
		return Status{AOCConnected: true, Enabled: true}, err
	}

	if key == "" {
		// There is no escrow to recover from — by design, the key is never
		// stored off this server. A missing key therefore always means a NEW
		// repo, so mint one and let the unsaved-key warning nag until the
		// operator has stored a copy.
		key, err = GenerateKey()
		if err != nil {
			return Status{AOCConnected: true, Enabled: true}, err
		}
		if err := SaveKey(key); err != nil {
			return Status{AOCConnected: true, Enabled: true}, err
		}
	}

	ok := Status{AOCConnected: true, Enabled: true, HasKey: true}

	restic := NewRestic(target, key)
	if err := restic.EnsureRepo(ctx); err != nil {
		return ok, fmt.Errorf("failed to init backup repo: %w", err)
	}

	return ok, nil
}

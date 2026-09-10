package core

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// PerfLogLine appends a one-line per-phase timing summary for a reconcile to a
// perf log, so first-time-to-live-dev can be profiled without guesswork. The
// path is BITSWAN_PERF_LOG if set, else <gitopsDir>/perf-reconcile.log.
// Best-effort: never fails a deploy.
func PerfLogLine(gitopsDir, bp string, timings []string, total time.Duration) {
	path := os.Getenv("BITSWAN_PERF_LOG")
	if path == "" {
		if gitopsDir == "" {
			return
		}
		path = filepath.Join(gitopsDir, "perf-reconcile.log")
	}
	line := fmt.Sprintf("%s bp=%s %s total=%dms\n",
		time.Now().UTC().Format(time.RFC3339), bp,
		strings.Join(timings, " "), total.Milliseconds())
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(line)
}

// PhaseTimer wraps a report callback so the wall-clock spent between consecutive
// report() calls is attributed to the step that just finished — turning the
// existing progress steps into a per-phase profile with zero per-phase edits.
type PhaseTimer struct {
	base     func(step, msg string)
	start    time.Time
	last     time.Time
	prevStep string
	timings  []string
}

func NewPhaseTimer(base func(step, msg string)) *PhaseTimer {
	now := time.Now()
	return &PhaseTimer{base: base, start: now, last: now}
}

// Report records the duration of the previous step, then forwards to base.
func (p *PhaseTimer) Report(step, msg string) {
	now := time.Now()
	if p.prevStep != "" {
		p.timings = append(p.timings,
			fmt.Sprintf("%s=%dms", p.prevStep, now.Sub(p.last).Milliseconds()))
	}
	p.last = now
	p.prevStep = step
	if p.base != nil {
		p.base(step, msg)
	}
}

// Finish records the final step's duration and writes the perf line.
func (p *PhaseTimer) Finish(gitopsDir, bp string) {
	if p.prevStep != "" {
		p.timings = append(p.timings,
			fmt.Sprintf("%s=%dms", p.prevStep, time.Since(p.last).Milliseconds()))
	}
	PerfLogLine(gitopsDir, bp, p.timings, time.Since(p.start))
}

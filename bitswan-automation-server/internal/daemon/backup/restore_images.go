package backup

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// Loading the saved business-process images back onto a rebuilt machine.
//
// This has to happen BEFORE any workspace converges. The compiler emits `image:`
// for BP app services with no `build:` and no `pull_policy`, and nothing in the
// apply path checks the image exists — so compose tries to pull `internal/…` from
// Docker Hub and the whole converge fails. gitops's own rebuild-from-revision pass
// covers that, but only for what it can rebuild; loading first means it has nothing
// left to do for images that were saved.
//
// Deliberately best-effort. A snapshot from before image backups existed, or from a
// server with them switched off, has no archive — and that must not fail a recovery
// that the rebuild path can still complete.

// ImagesRestore describes what came back, for the recovery report.
type ImagesRestore struct {
	// Loaded is the tags docker reported loading.
	Loaded []string
	// Missing is true when the backup simply has no image archive: an older
	// snapshot, or images were not being backed up. Not an error.
	Missing bool
}

// dockerLoadRunner is a seam so tests can drive the restore without docker.
var dockerLoadRunner = func(ctx context.Context, stdin *os.File) (string, error) {
	cmd := exec.CommandContext(ctx, dockerBinary, "load")
	cmd.Stdin = stdin
	var out, errBuf bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		return out.String(), fmt.Errorf("docker load failed: %w: %s",
			err, strings.TrimSpace(errBuf.String()))
	}
	return out.String(), nil
}

// RestoreImages streams the saved image archive out of the backup and into the
// local docker. snapshotID may be "" for the newest image snapshot.
func RestoreImages(ctx context.Context, restic *Restic, snapshotID string) (ImagesRestore, error) {
	var result ImagesRestore

	if snapshotID == "" {
		snapshotID = "latest"
	}
	// --no-lock because the archive may be read while authenticated with a recovery
	// OTP, which the AOC allows reads only, and taking a lock is a write.
	args := []string{"dump", "--no-lock"}
	if snapshotID == "latest" {
		// Scope "latest" to the image series or it resolves to whatever snapshot
		// is newest — usually a workspace's, which holds no archive.
		args = append(args, "--tag", imagesTag)
	}
	args = append(args, snapshotID, "/"+imagesArchiveName)

	pr, pw, err := os.Pipe()
	if err != nil {
		return result, err
	}

	// restic writes the archive into the pipe; docker load reads it out. Same real-
	// pipe reasoning as the backup direction (see pipeDockerSaveToRestic): an
	// *os.File is handed to the child directly, so a death on either side surfaces
	// as EOF or EPIPE instead of a hang.
	type dumpOutcome struct {
		stderr string
		err    error
	}
	done := make(chan dumpOutcome, 1)
	go func() {
		stderr, err := restic.RunStdout(ctx, pw, args...)
		pw.Close()
		done <- dumpOutcome{stderr: stderr, err: err}
	}()

	loadOut, loadErr := dockerLoadRunner(ctx, pr)
	pr.Close()
	dump := <-done

	if dump.err != nil {
		if isMissingImageArchive(dump.stderr) {
			result.Missing = true
			return result, nil
		}
		return result, dump.err
	}
	if loadErr != nil {
		return result, loadErr
	}

	result.Loaded = parseLoadedTags(loadOut)
	if len(result.Loaded) == 0 {
		return result, fmt.Errorf("the image archive restored but docker loaded nothing " +
			"from it — treat the images as absent and let them be rebuilt")
	}
	return result, nil
}

// isMissingImageArchive distinguishes "this backup has no image archive" from a
// real failure. Matching restic's message text is unpleasant but unavoidable: it
// exits 1 for both a missing path and a missing snapshot AND for an unreachable
// repository, so the exit code cannot tell them apart — and the difference decides
// whether a recovery continues or stops.
//
// Both messages verified against restic 0.17.3 rather than guessed:
//
//	no image snapshot yet:  Fatal: failed to find snapshot: snapshot filter
//	                        (Paths:[] Tags:[[images]] Hosts:[]): no snapshot found
//	snapshot without one:   Fatal: cannot dump file: path "/internal-images.tar"
//	                        not found in snapshot
//
// Narrow on purpose. Anything unrecognised — a refused connection, a bad
// credential — must fall through to a real error, because silently continuing past
// those would hide a broken backup behind a message about rebuilding images.
func isMissingImageArchive(stderr string) bool {
	s := strings.ToLower(stderr)
	return strings.Contains(s, "no snapshot found") ||
		strings.Contains(s, "not found in snapshot")
}

// parseLoadedTags reads the tags out of docker load's output ("Loaded image:
// internal/x:shaY" / "Loaded image ID: sha256:…").
func parseLoadedTags(out string) []string {
	var tags []string
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		const prefix = "Loaded image: "
		if strings.HasPrefix(line, prefix) {
			tags = append(tags, strings.TrimSpace(strings.TrimPrefix(line, prefix)))
		}
	}
	return tags
}

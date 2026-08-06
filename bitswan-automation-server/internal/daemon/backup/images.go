package backup

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
)

// Backing up the built business-process images.
//
// A BP's app image is tagged internal/{ws}-{bp}-{auto}-app:sha{H}, where H hashes
// the SOURCE TREE the image was built from — not the bytes that came out. gitops
// can therefore rebuild a missing image from the recorded revision and land on the
// same tag (resolve_missing_pinned_images), which is what makes rollback work and
// what a recovery falls back on.
//
// But the same-tag guarantee is about provenance, not content. The base image comes
// from the workspace's image/Dockerfile, and if that does an unpinned `pip install`
// or `apt-get install`, rebuilding the same tree next year yields the same tag over
// different bytes. `RUN build.sh` can fetch anything. An upstream FROM can move or
// be withdrawn. And a rebuild needs working network egress at the exact moment a
// disaster recovery is least able to assume it.
//
// So the rebuild restores *a* working image. This restores *the* image that was
// running. Both paths stay: a saved archive is architecture-specific, so recovering
// onto different hardware still needs the rebuild.
//
// Cost is far lower than it looks, because the tags heavily alias. Measured on a
// live server: 103 internal tags behind 26 distinct images, ~2.4GB of unique layer
// bytes. `docker save` given every tag at once writes each layer once and records
// all tag mappings, so one stream restores all 103 names.
//
// Later runs then cost almost nothing. NOT because the archive is byte-stable —
// a multi-image `docker save` is measurably not: two runs over the same six
// images produce different SHA-256. It is because restic chunks by content and
// addresses chunks by hash, so an identical layer dedupes wherever it lands in
// the stream. Measured into a scratch repo: first run added 529MiB, an immediate
// second run over the same images added 22.7KiB. Sorting the tag list is still
// worth doing — it keeps the argv deterministic — but it is not what makes this
// cheap, and assuming a stable stream would be the wrong thing to preserve.

// internalImageRef is the reference filter for BP images. Everything gitops builds
// for a business process is tagged under this prefix (see the tag format in
// automation_service.py); nothing else on the host is.
const internalImageRef = "internal/*"

// imagesArchiveName is the filename the archive takes inside the snapshot. restic
// stores a --stdin backup at /<stdin-filename>, so this is also the dump path the
// restore reads back (RestoreImages).
const imagesArchiveName = "internal-images.tar"

// imagesTag marks the image snapshot series, kept separate from files/postgres/
// couchdb/garage/server-config so retention and restore can address it alone.
const imagesTag = "images"

// dockerImagesLister is a seam: tests drive the image inventory without docker.
var dockerImagesLister = func(ctx context.Context) (string, error) {
	cmd := exec.CommandContext(ctx, dockerBinary, "images",
		"--filter", "reference="+internalImageRef,
		"--format", "{{.ID}}\t{{.Repository}}:{{.Tag}}")
	var out, errBuf bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("could not list internal images: %w: %s",
			err, strings.TrimSpace(errBuf.String()))
	}
	return out.String(), nil
}

// internalImages is the inventory: distinct image IDs and every tag pointing at
// each. Returns tags sorted, so the docker save argv — and therefore the archive —
// is stable across runs and does not churn the repo for no reason.
func internalImages(ctx context.Context) (ids []string, tags []string, err error) {
	raw, err := dockerImagesLister(ctx)
	if err != nil {
		return nil, nil, err
	}
	seenID := map[string]bool{}
	seenTag := map[string]bool{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) != 2 {
			continue
		}
		id, tag := strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
		// A dangling image has no usable name; saving it would restore nothing
		// addressable, and no bitswan.yaml can pin it.
		if id == "" || tag == "" || strings.HasSuffix(tag, ":<none>") {
			continue
		}
		if !seenID[id] {
			seenID[id] = true
			ids = append(ids, id)
		}
		if !seenTag[tag] {
			seenTag[tag] = true
			tags = append(tags, tag)
		}
	}
	sort.Strings(ids)
	sort.Strings(tags)
	return ids, tags, nil
}

// backupImages streams every named internal image into one snapshot.
//
// Best-effort like every other step: a failure here is recorded red and the run
// continues, because losing the image archive still leaves a backup from which
// gitops can rebuild.
func (e *Engine) backupImages(ctx context.Context, restic *Restic) StepResult {
	ids, tags, err := internalImages(ctx)
	if err != nil {
		return StepResult{Success: false, Output: err.Error()}
	}
	if len(tags) == 0 {
		// A server with no business processes deployed yet. Not a failure, and
		// worth saying so rather than reporting a silent success.
		return StepResult{Success: true, Output: "no internal images to save"}
	}

	args := restic.BackupArgs([]string{imagesTag})
	args = append(args, "--stdin", "--stdin-filename", imagesArchiveName)

	summary, err := pipeDockerSaveToRestic(ctx, restic, tags, args)
	prefix := fmt.Sprintf("%d image(s), %d tag(s)", len(ids), len(tags))
	if err != nil {
		return StepResult{Success: false, Output: prefix + ": " + err.Error()}
	}
	return StepResult{Success: true, Output: strings.TrimSpace(prefix + "; " + summary)}
}

// dockerSaveCommand builds the archive-producing command. A seam at the command
// rather than around the whole pipe, so tests exercise the real plumbing — the
// pipe, and what happens when one end dies — against a cheap stand-in stream.
var dockerSaveCommand = func(ctx context.Context, tags []string) *exec.Cmd {
	return exec.CommandContext(ctx, dockerBinary, append([]string{"save"}, tags...)...)
}

// pipeDockerSaveToRestic runs `docker save <tags> | restic <args>`.
//
// A real OS pipe rather than cmd.StdoutPipe: an *os.File becomes the child's fd
// directly, so if either side dies the other gets EOF or EPIPE from the kernel and
// exits. With an io.Reader, os/exec would interpose a copying goroutine that
// cmd.Wait blocks on, turning a broken pipe into a hung backup run.
func pipeDockerSaveToRestic(
	ctx context.Context, restic *Restic, tags []string, resticArgs []string,
) (string, error) {
	pr, pw, err := os.Pipe()
	if err != nil {
		return "", err
	}

	save := dockerSaveCommand(ctx, tags)
	save.Stdout = pw
	var saveErr bytes.Buffer
	save.Stderr = &saveErr

	if err := save.Start(); err != nil {
		pw.Close()
		pr.Close()
		return "", fmt.Errorf("could not start docker save: %w", err)
	}
	// The parent's write end must go now: while it stays open restic never sees
	// EOF, so it would wait forever after docker has finished.
	pw.Close()

	stdout, _, resticErr := restic.RunStdin(ctx, pr, resticArgs...)
	// Closing the read end unblocks docker with EPIPE if restic died early.
	pr.Close()
	waitErr := save.Wait()

	if resticErr != nil {
		return "", resticErr
	}
	if waitErr != nil {
		// restic succeeded on a truncated stream: it stored something, but the
		// archive is not the whole set and must not be trusted as if it were.
		return "", fmt.Errorf("docker save failed after restic accepted the stream "+
			"(the stored archive is incomplete): %w: %s", waitErr, strings.TrimSpace(saveErr.String()))
	}
	return resticAddedSummary(stdout), nil
}

// resticAddedSummary pulls restic's own "Added to the repository" line out of its
// output, so the step reports what the run actually cost rather than the nominal
// size of the images. After the first run this is near zero, which is the number
// worth showing an operator worried about storage.
func resticAddedSummary(stdout string) string {
	for _, line := range strings.Split(stdout, "\n") {
		if strings.Contains(line, "Added to the repo") {
			return strings.TrimSpace(line)
		}
	}
	return ""
}

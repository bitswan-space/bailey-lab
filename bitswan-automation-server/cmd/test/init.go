package test

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/automations"
	"github.com/bitswan-space/bitswan-workspaces/internal/daemon"
	"github.com/bitswan-space/bitswan-workspaces/internal/httpReq"
	"github.com/spf13/cobra"
)

// workspaceDaemonInfo returns a workspace's gitops URL and secret from the
// daemon. Workspace data lives in the daemon's Docker volume, which the host
// CLI can't read directly, so metadata must come from the daemon rather than
// config.GetWorkspaceMetadata (which reads the host filesystem). Requests the
// long form (for GitopsURL) and password fields (for GitopsSecret).
func workspaceDaemonInfo(client *daemon.Client, name string) (*daemon.WorkspaceInfo, error) {
	resp, err := client.ListWorkspaces(true, true)
	if err != nil {
		return nil, fmt.Errorf("failed to list workspaces: %w", err)
	}
	for i := range resp.Workspaces {
		if resp.Workspaces[i].Name == name {
			return &resp.Workspaces[i], nil
		}
	}
	return nil, fmt.Errorf("workspace %q not found", name)
}

func newInitCmd() *cobra.Command {
	var noRemove bool
	var gitopsImage string
	var codingAgentImage string

	cmd := &cobra.Command{
		Use:   "init",
		Short: "Test workspace initialization and business-process deployment",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runTestInit(noRemove, gitopsImage, codingAgentImage)
		},
	}

	cmd.Flags().BoolVar(&noRemove, "no-remove", false, "Leave workspace and deployment running (skip cleanup)")
	cmd.Flags().StringVar(&gitopsImage, "gitops-image", "", "Custom GitOps image to use (default: production image)")
	cmd.Flags().StringVar(&codingAgentImage, "coding-agent-image", "", "Custom coding-agent image to use (default: production image)")

	return cmd
}

func runTestInit(noRemove bool, gitopsImage, codingAgentImage string) error {
	fmt.Println("=== BitSwan Test Suite: Init ===")
	fmt.Println()

	// Ensure we're in a valid directory (the daemon will handle its own working directory)
	// We just need to make sure we're not in a deleted directory
	if wd, err := os.Getwd(); err != nil {
		// If we can't get the current directory, try to change to a known good location
		homeDir := os.Getenv("HOME")
		if homeDir == "" {
			homeDir = "/tmp"
		}
		if err := os.Chdir(homeDir); err != nil {
			return fmt.Errorf("failed to change to directory: %w", err)
		}
	} else {
		// Verify the directory still exists
		if _, err := os.Stat(wd); err != nil {
			homeDir := os.Getenv("HOME")
			if homeDir == "" {
				homeDir = "/tmp"
			}
			if err := os.Chdir(homeDir); err != nil {
				return fmt.Errorf("failed to change to directory: %w", err)
			}
		}
	}

	// Generate unique workspace name
	workspaceName := fmt.Sprintf("test-workspace-%d", time.Now().Unix())
	fmt.Printf("Test workspace name: %s\n", workspaceName)

	// On failure, only tear the workspace down when the caller hasn't asked to
	// keep it. --no-remove means "leave workspace and deployment running" — and
	// that's most valuable precisely when a step fails, so CI (which always
	// passes --no-remove) can dump container logs to diagnose the failure.
	cleanupOnFailure := func() {
		if !noRemove {
			cleanupWorkspace(workspaceName)
		}
	}

	// Step 1: Initialize workspace
	fmt.Println("\n[1/7] Initializing workspace...")
	client, err := daemon.NewClient()
	if err != nil {
		return fmt.Errorf("failed to create daemon client: %w", err)
	}

	// Use local flags for workspace init (no dashboard, no oauth for faster initialization)
	initArgs := []string{
		"workspace", "init",
		"--local",
		"--no-dashboard",
		"--no-oauth",
	}
	if gitopsImage != "" {
		initArgs = append(initArgs, "--gitops-image", gitopsImage)
	}
	if codingAgentImage != "" {
		initArgs = append(initArgs, "--coding-agent-image", codingAgentImage)
	}
	initArgs = append(initArgs, workspaceName)

	if err := client.WorkspaceInit(initArgs); err != nil {
		return fmt.Errorf("failed to initialize workspace: %w", err)
	}
	fmt.Println("✓ Workspace initialized")

	// Get workspace metadata from the daemon. Workspace data lives in the
	// daemon's Docker volume, which the host CLI can't read directly, so we
	// can't use config.GetWorkspaceMetadata (it reads the host filesystem).
	metadata, err := workspaceDaemonInfo(client, workspaceName)
	if err != nil {
		return fmt.Errorf("failed to get workspace metadata: %w", err)
	}

	// Step 2: Wait for gitops service to be ready
	fmt.Println("\n[2/7] Waiting for gitops service to be ready...")
	if err := waitForGitopsReady(metadata.GitopsURL, metadata.GitopsSecret, workspaceName); err != nil {
		cleanupOnFailure()
		return fmt.Errorf("gitops service did not become ready: %w", err)
	}
	fmt.Println("✓ Gitops service ready")

	// Step 3: Create a business process. Gitops scaffolds the default template
	// group (BITSWAN_DEFAULT_TEMPLATE_GROUP, "business-process": one frontend
	// exposed through Bailey + one private backend worker) into <bp>/ and kicks
	// off its deploy in the background. This is the real user flow — there is no
	// standalone template-scaffolding step to test anymore.
	fmt.Println("\n[3/7] Creating business process...")
	const bp = "test"
	automationsCreated, deployTaskID, err := createBusinessProcess(metadata.GitopsURL, metadata.GitopsSecret, workspaceName, bp)
	if err != nil {
		cleanupOnFailure()
		return fmt.Errorf("failed to create business process: %w", err)
	}
	if deployTaskID == "" {
		cleanupOnFailure()
		return fmt.Errorf("business process %q created but its auto-deploy did not start", bp)
	}

	fmt.Printf("✓ Business process %q created (automations: %s)\n", bp, strings.Join(automationsCreated, ", "))

	// Step 4: Wait for the BP deploy pipeline to finish. This builds the
	// frontend + backend images from their image/Dockerfiles, provisions the
	// backend's Postgres + MinIO, and runs compose up.
	fmt.Println("\n[4/7] Waiting for business-process deploy to complete...")
	if err := waitForDeployTask(metadata.GitopsURL, metadata.GitopsSecret, workspaceName, deployTaskID); err != nil {
		cleanupOnFailure()
		return fmt.Errorf("business-process deploy did not complete: %w", err)
	}
	fmt.Println("✓ Business process deployed")

	// Verify the embedded fast-forward-only git server against the BP's OWN
	// repo (every business process has one): clone it, push a fast-forward on
	// a branch (succeeds), push to main (rejected — deploy-only), and attempt
	// a history rewrite / force-push (rejected by the pre-receive hook). Also
	// probe that the legacy single-repo path is gone. Run this AFTER the deploy
	// settles so the verification never races the background build the BP's
	// creation kicks off.
	fmt.Println("\nVerifying fast-forward-only per-BP git server...")
	if err := verifyGitServer(metadata.GitopsURL, metadata.GitopsSecret, "/git/"+bp+".git"); err != nil {
		cleanupOnFailure()
		return fmt.Errorf("git server verification failed: %w", err)
	}
	if err := verifyGitServer(metadata.GitopsURL, metadata.GitopsSecret, "/git/repo.git"); err == nil {
		cleanupOnFailure()
		return fmt.Errorf("legacy /git/repo.git is still being served — per-BP migration incomplete")
	}
	fmt.Println("✓ Git server: per-BP clone + ff push OK; main push + force-push rejected; legacy repo gone")

	// Step 5: The frontend is the only part exposed through Bailey. Wait for it
	// to be running and confirm it serves its app shell — that's "the frontend
	// is accessible" end to end.
	fmt.Println("\n[5/7] Waiting for the frontend to be accessible...")
	frontendURL, err := waitForFrontendRunning(metadata.GitopsURL, metadata.GitopsSecret, workspaceName, bp)
	if err != nil {
		cleanupOnFailure()
		return fmt.Errorf("frontend did not become ready: %w", err)
	}
	fmt.Printf("✓ Frontend running at: %s\n", frontendURL)

	fmt.Println("\nTesting frontend...")
	if err := testFrontendEndpoint(frontendURL, workspaceName); err != nil {
		cleanupOnFailure()
		return fmt.Errorf("frontend accessibility test failed: %w", err)
	}
	fmt.Println("✓ Frontend is accessible")

	// Step 6: The coding-agent CLI must authenticate to gitops from inside the
	// coding-agent container. This guards the agent-token path end to end:
	// gitops has to resolve the same BITSWAN_GITOPS_AGENT_SECRET the agent
	// container was given, or every `bitswan-coding-agent` call 401s.
	fmt.Println("\n[6/7] Verifying coding-agent CLI authentication...")
	if err := testCodingAgentCLI(workspaceName); err != nil {
		cleanupOnFailure()
		return fmt.Errorf("coding-agent CLI authentication check failed: %w", err)
	}
	fmt.Println("✓ Coding-agent CLI authenticated to gitops")

	if noRemove {
		fmt.Println("\n[7/7] Skipping cleanup (--no-remove flag set)...")
		fmt.Printf("Workspace '%s' is still running\n", workspaceName)
		fmt.Printf("Frontend: %s\n", frontendURL)
		fmt.Println("\n=== Test Suite: SUCCESS (workspace left running) ===")
		return nil
	}

	// Step 7: Tear down the whole workspace (removes the BP's containers,
	// services, and routes along with it).
	fmt.Println("\n[7/7] Cleaning up...")
	if err := cleanupWorkspace(workspaceName); err != nil {
		return fmt.Errorf("failed to cleanup workspace: %w", err)
	}
	fmt.Println("✓ Workspace removed")

	fmt.Println("\n=== Test Suite: SUCCESS ===")
	return nil
}

// createBusinessProcess creates a business process via gitops' POST /processes/.
// Gitops scaffolds the default template group (one frontend + one backend
// worker) into <name>/ and kicks off its deploy in the background. Returns the
// scaffolded automation names and the deploy task id (poll it with
// waitForDeployTask). A non-empty setup_error in the response is surfaced as an
// error — auto-setup failing is exactly what this test must catch.
func createBusinessProcess(gitopsURL, secret, workspaceName, name string) ([]string, string, error) {
	payload := map[string]string{"name": name}
	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, "", err
	}

	reqURL := fmt.Sprintf("%s/processes/", gitopsURL)
	reqURL = automations.TransformURLForDaemon(reqURL, workspaceName)
	req, err := httpReq.NewRequest("POST", reqURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+secret)

	resp, err := httpReq.ExecuteRequestWithLocalhostResolution(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("create-process failed with status %d: %s", resp.StatusCode, string(respBytes))
	}

	var result struct {
		AutomationsCreated []string `json:"automations_created"`
		DeployTaskID       string   `json:"deploy_task_id"`
		SetupError         string   `json:"setup_error"`
	}
	if err := json.Unmarshal(respBytes, &result); err != nil {
		return nil, "", fmt.Errorf("failed to parse create-process response: %w (body: %s)", err, string(respBytes))
	}
	if result.SetupError != "" {
		return nil, "", fmt.Errorf("business-process auto-setup failed: %s", result.SetupError)
	}
	return result.AutomationsCreated, result.DeployTaskID, nil
}

// maxHostnameLabelLen mirrors gitops' MAX_NAME_LEN (app/services/automation_service.py):
// workspace_name and automation_name are each capped at 24 chars so the final
// DNS label fits within the 63-char limit.
const maxHostnameLabelLen = 24

// sanitizeAutomationNameRE mirrors gitops' sanitize_automation_name
// (app/utils.py): lowercase, replace every char outside [a-z0-9-] with '-'.
var sanitizeAutomationNameRE = regexp.MustCompile(`[^a-z0-9-]`)

// sanitizeAutomationName replicates gitops' sanitize_automation_name exactly:
// lowercase the input, replace each char outside [a-z0-9-] with '-', then trim
// leading/trailing hyphens. Deploy-id derivation and template scaffolding both
// depend on this, so the e2e must produce the identical output.
func sanitizeAutomationName(name string) string {
	lowered := strings.ToLower(name)
	replaced := sanitizeAutomationNameRE.ReplaceAllString(lowered, "-")
	return strings.Trim(replaced, "-")
}

// shortContextHash replicates gitops' _short_hash
// (app/services/automation_service.py): the first 4 hex chars of the SHA-256 of
// the context string. e.g. _short_hash("test") == "9f86".
func shortContextHash(context string) string {
	sum := sha256.Sum256([]byte(context))
	return hex.EncodeToString(sum[:])[:4]
}

// makeHostnameLabel replicates gitops' make_hostname_label
// (app/services/automation_service.py). It builds the DNS label from structured
// components — no string parsing — capping workspace_name and automation_name at
// 24 chars each:
//
//	context && stage -> "<ws>-<an>-<ctxhash>-<stage>"
//	context only     -> "<ws>-<an>-<ctxhash>"
//	stage only       -> "<ws>-<an>-<stage>"
//	neither          -> "<ws>-<an>"
func makeHostnameLabel(workspaceName, automationName, context, stage string) string {
	ws := workspaceName
	if len(ws) > maxHostnameLabelLen {
		ws = ws[:maxHostnameLabelLen]
	}
	an := automationName
	if len(an) > maxHostnameLabelLen {
		an = an[:maxHostnameLabelLen]
	}
	if context != "" {
		h := shortContextHash(context)
		if stage != "" {
			return fmt.Sprintf("%s-%s-%s-%s", ws, an, h, stage)
		}
		return fmt.Sprintf("%s-%s-%s", ws, an, h)
	}
	if stage != "" {
		return fmt.Sprintf("%s-%s-%s", ws, an, stage)
	}
	return fmt.Sprintf("%s-%s", ws, an)
}

// constructFrontendURL reproduces, from structured inputs only, the exact
// https URL gitops registers for the business process's frontend route — without
// reading it back from get_automations (whose state/automation_url overlay can
// lag in CI). It mirrors gitops' generate_workspace_url
// (app/utils.py) + add_workspace_route_to_ingress, which build the host as
// "<make_hostname_label(...)>.<BITSWAN_GITOPS_DOMAIN>".
//
// The inputs for a main (non-copy) BP deploy are fixed by gitops itself:
//   - workspace   = the test workspace name (capped/sanitized below)
//   - automation  = "frontend" (the exposed automation in the default
//     business-process template group)
//   - context     = the sanitized BP name (scan_workspace_sources sets
//     context = bp_name for non-copy scans), i.e. sanitize("test")
//   - stage       = "dev" (routes/processes.py: stage = "dev" when there is no
//     copy; "live-dev" only for copy deploys)
//
// The gitops domain is BITSWAN_GITOPS_DOMAIN, which the daemon sets to the
// workspace's domain (dockercompose.go) and which equals the host of the gitops
// URL with the leading "<workspace>-gitops." label stripped (workspace_init.go
// builds GitopsURL as "https://<ws>-gitops.<domain>"). Deriving the domain from
// gitopsURL this way handles every regime identically — e.g. the --local CI
// regime where domain == "bs-<workspace>.localhost" (so the constructed host
// ends in .localhost and resolves through dnsmasq/mkcert just like the gitops
// URL itself).
func constructFrontendURL(gitopsURL, workspaceName, bp string) (string, error) {
	parsed, err := url.Parse(gitopsURL)
	if err != nil {
		return "", fmt.Errorf("failed to parse gitops URL %q: %w", gitopsURL, err)
	}
	host := parsed.Host
	// Strip the "<workspace>-gitops." label to recover BITSWAN_GITOPS_DOMAIN.
	gitopsLabelPrefix := workspaceName + "-gitops."
	if !strings.HasPrefix(host, gitopsLabelPrefix) {
		return "", fmt.Errorf("gitops URL host %q does not start with expected prefix %q", host, gitopsLabelPrefix)
	}
	gitopsDomain := strings.TrimPrefix(host, gitopsLabelPrefix)
	if gitopsDomain == "" {
		return "", fmt.Errorf("could not derive gitops domain from host %q", host)
	}

	// Match gitops' deploy-time inputs for the main-BP frontend route.
	sanitizedWorkspace := sanitizeAutomationName(workspaceName)
	context := sanitizeAutomationName(bp)
	const automationName = "frontend"
	const stage = "dev"

	label := makeHostnameLabel(sanitizedWorkspace, automationName, context, stage)
	scheme := parsed.Scheme
	if scheme == "" {
		scheme = "https"
	}
	return fmt.Sprintf("%s://%s.%s", scheme, label, gitopsDomain), nil
}

// waitForFrontendRunning polls gitops' GET /automations/ for the business
// process's frontend and returns its URL once it's actually serving. The
// frontend is the automation exposed through Bailey (expose=true) whose
// relative_path ends in "/frontend" — identified by explicit data, not a
// guessed hostname. The per-automation images were already built by the deploy
// task, so 3 minutes is a generous margin for the container to come up.
//
// Readiness is established by EITHER signal:
//
//	(1) get_automations reports state=="running", OR
//	(2) the frontend's own URL is reachable (HTTP 200 + app shell) through the
//	    gate, even if the get_automations 'state' field still lags.
//
// In the dev stage the overlay/label-matching that populates 'state' can lag
// behind the container actually serving (observed only in CI), so relying on
// 'state' alone makes this flaky. Probing the real URL keeps the check a true
// end-to-end assertion — the frontend must genuinely return its HTML — without
// depending on the lagging state field. Once the frontend's endpoint URL is
// known we probe it directly; the first signal to fire wins.
func waitForFrontendRunning(gitopsURL, secret, workspaceName, bp string) (string, error) {
	maxAttempts := 90 // 3 minutes (90 * 2 seconds)

	// Construct the frontend's URL the same way gitops registers its route, so
	// the e2e never depends on the get_automations overlay populating
	// automation_url (it can lag in CI — observed as "Frontend present but no
	// URL yet"). This is the fallback probe target when the entry has no URL.
	constructedURL, constructErr := constructFrontendURL(gitopsURL, workspaceName, bp)
	if constructErr != nil {
		fmt.Printf("  Warning: could not construct frontend URL (will rely on get_automations): %v\n", constructErr)
	} else {
		fmt.Printf("  Constructed frontend URL: %s\n", constructedURL)
	}

	for attempt := 0; attempt < maxAttempts; attempt++ {
		reqURL := fmt.Sprintf("%s/automations/", gitopsURL)
		reqURL = automations.TransformURLForDaemon(reqURL, workspaceName)
		req, err := httpReq.NewRequest("GET", reqURL, nil)
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}
		req.Header.Set("Authorization", "Bearer "+secret)

		resp, err := httpReq.ExecuteRequestWithLocalhostResolution(req)
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}
		bodyBytes, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			time.Sleep(2 * time.Second)
			continue
		}

		var autos []struct {
			State         string `json:"state"`
			Expose        bool   `json:"expose"`
			RelativePath  string `json:"relative_path"`
			EndpointName  string `json:"endpoint_name"`
			AutomationURL string `json:"automation_url"`
		}
		if err := json.Unmarshal(bodyBytes, &autos); err != nil {
			time.Sleep(2 * time.Second)
			continue
		}

		for _, a := range autos {
			if !a.Expose {
				continue
			}
			rel := strings.TrimRight(a.RelativePath, "/")
			if !strings.HasSuffix(rel, bp+"/frontend") {
				continue
			}

			// Resolve the frontend's URL. Prefer the entry's own
			// automation_url / endpoint_name (populated from route metadata
			// independently of 'state'), but fall back to the URL we
			// constructed ourselves when the entry carries no URL — in CI the
			// overlay that fills automation_url can lag, leaving the entry with
			// empty state AND empty url even though the container is serving.
			endpointURL := a.AutomationURL
			if endpointURL == "" && a.EndpointName != "" {
				if parsed, err := url.Parse(gitopsURL); err == nil {
					endpointURL = fmt.Sprintf("%s://%s/%s", parsed.Scheme, parsed.Host, a.EndpointName)
				}
			}
			if endpointURL == "" {
				endpointURL = constructedURL
			}

			// Signal (1): get_automations explicitly reports running (only a
			// fast-path when the entry also gave us a URL).
			if a.State == "running" && a.AutomationURL != "" {
				fmt.Printf("  Frontend ready (state=running)! URL: %s\n", a.AutomationURL)
				// Give the shim/vite a moment to fully start serving.
				time.Sleep(3 * time.Second)
				return a.AutomationURL, nil
			}

			// Signal (2): probe the URL directly (entry URL if present, else the
			// constructed URL). If the gate serves the app shell, the frontend
			// is genuinely up regardless of the lagging 'state'/overlay fields.
			if endpointURL != "" && frontendServesAppShell(endpointURL, workspaceName) {
				fmt.Printf("  Frontend reachable (state=%s, URL serves the app shell)! URL: %s\n", a.State, endpointURL)
				return endpointURL, nil
			}

			if attempt%5 == 0 {
				if endpointURL == "" {
					fmt.Printf("  Frontend present but no URL yet (state=%s, attempt %d/%d)\n", a.State, attempt+1, maxAttempts)
				} else {
					fmt.Printf("  Waiting for frontend... (state=%s, URL=%s not yet serving, attempt %d/%d)\n", a.State, endpointURL, attempt+1, maxAttempts)
				}
			}
			break
		}

		time.Sleep(2 * time.Second)
	}

	return "", fmt.Errorf("frontend did not become ready within timeout")
}

// frontendServesAppShell probes the frontend URL through the gate (localhost
// resolution) and reports whether it returns HTTP 200 with the React app shell.
// This is the same liveness criterion as testFrontendEndpoint, used as the
// reachability signal in waitForFrontendRunning so the e2e doesn't depend on
// the (CI-flaky) get_automations 'state' field. Any transport error or non-200
// is treated as "not ready yet" — the caller retries.
func frontendServesAppShell(endpointURL, workspaceName string) bool {
	reqURL := automations.TransformURLForDaemon(endpointURL, workspaceName)
	req, err := httpReq.NewRequest("GET", reqURL, nil)
	if err != nil {
		return false
	}
	resp, err := httpReq.ExecuteRequestWithLocalhostResolution(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	bodyBytes, _ := io.ReadAll(resp.Body)
	body := string(bodyBytes)
	lower := strings.ToLower(body)
	return strings.Contains(body, `id="root"`) || strings.Contains(lower, "<html")
}

// testFrontendEndpoint fetches the frontend URL and verifies it serves the app
// shell. A frontend returns its HTML document (not a JSON health body), so
// success is HTTP 200 plus the React app's root mount point in the markup.
func testFrontendEndpoint(endpointURL, workspaceName string) error {
	reqURL := automations.TransformURLForDaemon(endpointURL, workspaceName)
	req, err := httpReq.NewRequest("GET", reqURL, nil)
	if err != nil {
		return err
	}

	resp, err := httpReq.ExecuteRequestWithLocalhostResolution(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("frontend returned status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	body := string(bodyBytes)
	lower := strings.ToLower(body)
	if !strings.Contains(body, `id="root"`) && !strings.Contains(lower, "<html") {
		return fmt.Errorf("frontend response does not look like the app shell: %s", body)
	}

	return nil
}

// testCodingAgentCLI verifies the bitswan-coding-agent CLI can authenticate to
// gitops from inside the coding-agent container. `deployments list` hits gitops
// GET /agent/deployments with the agent token — the same agent-token auth path
// the git credential helper uses to push. This guards the agent-token wiring:
// gitops must resolve the same BITSWAN_GITOPS_AGENT_SECRET the coding-agent
// container was given, or every agent call 401s.
//
// We pass --copy explicitly. Without it the CLI tries to auto-detect the
// copy from $PWD and fails client-side ("cannot detect copy") before
// ever contacting gitops — so it can't test auth for this e2e, which deploys a
// main (non-copy) BP and therefore has no copy on disk. With the flag
// the request reaches the handler: gitops runs verify_agent_token first, so a
// good token yields HTTP 200 (an empty list for a copy that doesn't exist —
// scan_workspace_sources returns [] for a missing dir) while a bad token yields
// 401. Either way the listed contents are irrelevant; the not-401 round-trip is
// the signal we want.
func testCodingAgentCLI(workspaceName string) error {
	container, err := codingAgentContainer(workspaceName)
	if err != nil {
		return err
	}

	cmd := exec.Command("docker", "exec", container,
		"bitswan-coding-agent", "deployments", "list", "--copy", workspaceName)
	out, runErr := cmd.CombinedOutput()
	output := strings.TrimSpace(string(out))

	// The specific failure we're guarding against: gitops couldn't resolve the
	// agent secret, so it rejects the bearer token.
	if strings.Contains(output, "Invalid agent token") || strings.Contains(output, "HTTP 401") {
		return fmt.Errorf("gitops rejected the coding-agent token (agent secret not resolved): %s", output)
	}
	if runErr != nil {
		return fmt.Errorf("`bitswan-coding-agent deployments list` failed: %v: %s", runErr, output)
	}
	return nil
}

// codingAgentContainer resolves the coding-agent container name for a workspace.
// The coding-agent service pins container_name to {workspace}-coding-agent, but
// resolve by name filter so the check tolerates a compose-default name too.
func codingAgentContainer(workspaceName string) (string, error) {
	cmd := exec.Command("docker", "ps",
		"--filter", "name="+workspaceName+"-coding-agent",
		"--format", "{{.Names}}")
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("failed to list coding-agent containers: %w", err)
	}
	names := strings.Fields(string(out))
	if len(names) == 0 {
		return "", fmt.Errorf("no coding-agent container found for workspace %q", workspaceName)
	}
	return names[0], nil
}

// createAutomationFromTemplate scaffolds an automation from a built-in template
// (e.g. "FastAPIApp") into the workspace repo via gitops' POST
// /automations/from-template endpoint. gitops copies the template — sourced from
// the read-only examples tree mounted at /workspace/examples — into
// /workspace-repo/<bp>/<name>, injects a deployment id, and commits it. Returns
// the workspace-relative path of the created automation (e.g. "test/fastapi").
func createAutomationFromTemplate(gitopsURL, secret, workspaceName, templateID, bp, name string) (string, error) {
	payload := map[string]string{
		"template_id": templateID,
		"bp":          bp,
		"name":        name,
	}
	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	url := fmt.Sprintf("%s/automations/from-template", gitopsURL)
	url = automations.TransformURLForDaemon(url, workspaceName)
	req, err := httpReq.NewRequest("POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+secret)

	resp, err := httpReq.ExecuteRequestWithLocalhostResolution(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("from-template failed with status %d: %s", resp.StatusCode, string(respBytes))
	}

	var result struct {
		Created []struct {
			Name         string `json:"name"`
			RelativePath string `json:"relative_path"`
		} `json:"created"`
	}
	if err := json.Unmarshal(respBytes, &result); err != nil {
		return "", fmt.Errorf("failed to parse from-template response: %w (body: %s)", err, string(respBytes))
	}
	if len(result.Created) == 0 {
		return "", fmt.Errorf("from-template created no automations (body: %s)", string(respBytes))
	}
	return result.Created[0].RelativePath, nil
}

// startDeploy kicks off a deploy of a workspace-resident automation via gitops'
// POST /automations/start-deploy endpoint. gitops reads the source from
// /workspace-repo, builds the image (if the automation ships an image/Dockerfile),
// computes the merged-tree checksum, and runs the deploy pipeline in the
// background. The endpoint returns 202 immediately; use waitForDeployTask to
// block until the background pipeline finishes. Returns the task id, deployment
// id, and the (possibly empty) exposed URL gitops constructed.
func startDeploy(gitopsURL, secret, workspaceName, relativePath, stage string) (taskID, deploymentID, url string, err error) {
	payload := map[string]interface{}{
		"relative_path": relativePath,
		"stage":         stage,
	}
	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return "", "", "", err
	}

	reqURL := fmt.Sprintf("%s/automations/start-deploy", gitopsURL)
	reqURL = automations.TransformURLForDaemon(reqURL, workspaceName)
	req, err := httpReq.NewRequest("POST", reqURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return "", "", "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+secret)

	resp, err := httpReq.ExecuteRequestWithLocalhostResolution(req)
	if err != nil {
		return "", "", "", err
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusAccepted {
		return "", "", "", fmt.Errorf("start-deploy failed with status %d: %s", resp.StatusCode, string(respBytes))
	}

	var result struct {
		TaskID       string `json:"task_id"`
		DeploymentID string `json:"deployment_id"`
		Checksum     string `json:"checksum"`
		URL          string `json:"url"`
		Status       string `json:"status"`
	}
	if err := json.Unmarshal(respBytes, &result); err != nil {
		return "", "", "", fmt.Errorf("failed to parse start-deploy response: %w (body: %s)", err, string(respBytes))
	}
	return result.TaskID, result.DeploymentID, result.URL, nil
}

// waitForDeployTask polls gitops' GET /automations/deploy-status/{task_id}
// endpoint until the background deploy pipeline reaches a terminal state.
// Returns nil on "completed" and an error (carrying the server-side detail) on
// "failed" or timeout. This only covers the background deploy pipeline (compose
// up, cert install, oauth proxy) — the image build already ran synchronously
// inside the start-deploy call — so a few minutes is plenty.
func waitForDeployTask(gitopsURL, secret, workspaceName, taskID string) error {
	maxAttempts := 150 // 5 minutes (150 * 2 seconds)

	for attempt := 0; attempt < maxAttempts; attempt++ {
		reqURL := fmt.Sprintf("%s/automations/deploy-status/%s", gitopsURL, taskID)
		reqURL = automations.TransformURLForDaemon(reqURL, workspaceName)
		req, err := httpReq.NewRequest("GET", reqURL, nil)
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}
		req.Header.Set("Authorization", "Bearer "+secret)

		resp, err := httpReq.ExecuteRequestWithLocalhostResolution(req)
		if err != nil {
			time.Sleep(2 * time.Second)
			continue
		}
		bodyBytes, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		if resp.StatusCode == http.StatusOK {
			var task struct {
				Status  string `json:"status"`
				Step    string `json:"step"`
				Message string `json:"message"`
				Error   string `json:"error"`
			}
			if err := json.Unmarshal(bodyBytes, &task); err == nil {
				switch task.Status {
				case "completed":
					return nil
				case "failed":
					if task.Error != "" {
						return fmt.Errorf("deploy task failed: %s", task.Error)
					}
					return fmt.Errorf("deploy task failed: %s", task.Message)
				default:
					if attempt%10 == 0 {
						fmt.Printf("  Deploy in progress (status=%s, step=%s): %s (attempt %d/%d)\n", task.Status, task.Step, task.Message, attempt+1, maxAttempts)
					}
				}
			}
		} else if attempt%30 == 0 {
			fmt.Printf("  deploy-status returned %d (attempt %d/%d): %s\n", resp.StatusCode, attempt+1, maxAttempts, string(bodyBytes))
		}

		time.Sleep(2 * time.Second)
	}

	return fmt.Errorf("deploy task did not complete within timeout")
}

// computeImageDirHash calculates the git tree hash of the FastAPI image/ directory.
// This is used to ensure automation.toml references the correct image tag.
func computeImageDirHash() (string, error) {
	homeDir := os.Getenv("HOME")
	if homeDir == "" {
		return "", fmt.Errorf("HOME environment variable not set")
	}

	imageDir := filepath.Join(homeDir, ".config", "bitswan", "bitswan-src", "examples", "FastAPIApp", "image")
	if _, err := os.Stat(imageDir); os.IsNotExist(err) {
		return "", fmt.Errorf("image directory not found: %w", err)
	}

	return calculateGitTreeHash(imageDir)
}

// NOTE: No longer used by the init test, which now deploys via the
// workspace-mounted flow (createAutomationFromTemplate + startDeploy). Retained
// only for the legacy pull-and-deploy test, which still targets gitops' removed
// upload endpoints and is pending migration (see TODO in pull_and_deploy.go).
func createFastAPIZip(imageHash string) (string, string, error) {
	// Find the FastAPI example directory in bitswan-src
	homeDir := os.Getenv("HOME")
	if homeDir == "" {
		return "", "", fmt.Errorf("HOME environment variable not set")
	}

	fastAPIDir := filepath.Join(homeDir, ".config", "bitswan", "bitswan-src", "examples", "FastAPIApp")

	// Check if directory exists
	if _, err := os.Stat(fastAPIDir); os.IsNotExist(err) {
		return "", "", fmt.Errorf("FastAPI example directory not found at %s. Ensure workspace init has created bitswan-src", fastAPIDir)
	}

	// If we have a valid image hash, build the patched automation.toml content
	// so the image tag matches the actual image/ directory content. The upstream
	// example may have a stale tag if someone updated the Dockerfile without
	// regenerating the hash in automation.toml.
	//
	// We patch in a temp copy rather than in-place because the source tree may
	// be read-only (e.g. cloned by a different user in CI).
	var patchedAutomationToml []byte // nil means no patching needed
	if imageHash != "" {
		automationToml := filepath.Join(fastAPIDir, "automation.toml")
		if data, err := os.ReadFile(automationToml); err == nil {
			correctTag := fmt.Sprintf("\"internal/fastapi:sha%s\"", imageHash)
			lines := strings.Split(string(data), "\n")
			changed := false
			for i, line := range lines {
				trimmed := strings.TrimSpace(line)
				if strings.HasPrefix(trimmed, "image=") || strings.HasPrefix(trimmed, "image = ") {
					lines[i] = "image=" + correctTag
					changed = true
				}
			}
			if !changed {
				lines = append(lines, "image="+correctTag)
			}
			patchedAutomationToml = []byte(strings.Join(lines, "\n"))
			fmt.Printf("Patching automation.toml in ZIP: image tag set to %s\n", correctTag)
		}
	}

	// Calculate the git tree hash of the directory.
	// Note: if we patched automation.toml, the checksum won't reflect the patch,
	// but that's fine — the checksum is used as an asset identifier for upload,
	// and gitops will rebuild its own hash from the uploaded content.
	checksum, err := calculateGitTreeHash(fastAPIDir)
	if err != nil {
		return "", "", fmt.Errorf("failed to calculate checksum: %w", err)
	}

	// Create temporary ZIP file
	tmpFile, err := os.CreateTemp("", "fastapi-test-*.zip")
	if err != nil {
		return "", "", fmt.Errorf("failed to create temp file: %w", err)
	}
	zipPath := tmpFile.Name()
	tmpFile.Close()

	// Create ZIP file
	zipFile, err := os.Create(zipPath)
	if err != nil {
		return "", "", fmt.Errorf("failed to create ZIP file: %w", err)
	}
	defer zipFile.Close()

	zipWriter := zip.NewWriter(zipFile)
	defer zipWriter.Close()

	// Walk directory and add files to ZIP
	err = filepath.Walk(fastAPIDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		// Skip .git and other hidden files
		if strings.HasPrefix(info.Name(), ".") {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		// Calculate relative path
		relPath, err := filepath.Rel(fastAPIDir, path)
		if err != nil {
			return err
		}

		if info.IsDir() {
			return nil
		}

		// Create file in ZIP
		zipEntry, err := zipWriter.Create(relPath)
		if err != nil {
			return err
		}

		// Use patched content for automation.toml if available
		if relPath == "automation.toml" && patchedAutomationToml != nil {
			_, err = zipEntry.Write(patchedAutomationToml)
			return err
		}

		// Open and copy file content
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()

		_, err = io.Copy(zipEntry, file)
		return err
	})

	if err != nil {
		os.Remove(zipPath)
		return "", "", fmt.Errorf("failed to create ZIP: %w", err)
	}

	return zipPath, checksum, nil
}

// NOTE: No longer used by the init test. The workspace-mounted deploy flow lets
// gitops compute checksums itself, so this is retained only for the legacy
// pull-and-deploy test, which is pending migration (see TODO in pull_and_deploy.go).
//
// calculateGitTreeHash calculates the git tree hash of a directory
// This implements git's tree object format
func calculateGitTreeHash(dirPath string) (string, error) {
	// Try to use git command if available (most accurate)
	if gitPath, err := exec.LookPath("git"); err == nil {
		cmd := exec.Command(gitPath, "hash-object", "-t", "tree", "--stdin")
		cmd.Dir = dirPath

		// Create a temporary git index
		tmpDir, err := os.MkdirTemp("", "git-tree-hash-*")
		if err != nil {
			return "", err
		}
		defer os.RemoveAll(tmpDir)

		// Copy directory to temp location and use git
		// Actually, let's use a simpler approach: use git hash-object on the directory
		// But git hash-object doesn't work on directories directly
		// So we need to implement it ourselves or use git write-tree

		// For now, let's implement a basic version
	}

	// Implement git tree hash calculation
	return calculateGitTreeHashRecursive(dirPath)
}

func calculateGitTreeHashRecursive(dirPath string) (string, error) {
	type entry struct {
		mode  string
		name  string
		hash  string
		isDir bool
	}

	var entries []entry

	// Read directory
	files, err := os.ReadDir(dirPath)
	if err != nil {
		return "", err
	}

	// Process each file/directory
	for _, file := range files {
		// Skip .git and hidden files
		if strings.HasPrefix(file.Name(), ".") {
			continue
		}

		filePath := filepath.Join(dirPath, file.Name())

		if file.IsDir() {
			// Recursively calculate tree hash for subdirectory
			subHash, err := calculateGitTreeHashRecursive(filePath)
			if err != nil {
				return "", err
			}
			entries = append(entries, entry{
				mode:  "040000",
				name:  file.Name(),
				hash:  subHash,
				isDir: true,
			})
		} else {
			// Calculate blob hash for file
			blobHash, err := calculateGitBlobHash(filePath)
			if err != nil {
				return "", err
			}

			// Determine file mode (executable or regular)
			info, err := os.Stat(filePath)
			if err != nil {
				return "", err
			}
			mode := "100644" // regular file
			if info.Mode().Perm()&0111 != 0 {
				mode = "100755" // executable
			}

			entries = append(entries, entry{
				mode:  mode,
				name:  file.Name(),
				hash:  blobHash,
				isDir: false,
			})
		}
	}

	// Sort entries: directories first, then alphabetically
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].isDir != entries[j].isDir {
			return entries[i].isDir // directories first
		}
		return entries[i].name < entries[j].name
	})

	// Build tree object: "tree <size>\0<entries>"
	var treeContent []byte
	for _, e := range entries {
		// Each entry: "<mode> <name>\0<20-byte-sha1>"
		hashBytes, err := hex.DecodeString(e.hash)
		if err != nil {
			return "", fmt.Errorf("invalid hash: %w", err)
		}

		entryStr := fmt.Sprintf("%s %s\000", e.mode, e.name)
		treeContent = append(treeContent, []byte(entryStr)...)
		treeContent = append(treeContent, hashBytes...)
	}

	// Create tree header: "tree <size>\0"
	treeHeader := fmt.Sprintf("tree %d\000", len(treeContent))
	treeObject := append([]byte(treeHeader), treeContent...)

	// Calculate SHA1 hash
	hasher := sha1.New()
	hasher.Write(treeObject)
	hash := hex.EncodeToString(hasher.Sum(nil))

	return hash, nil
}

// NOTE: No longer used by the init test; only reached via calculateGitTreeHash
// from the legacy pull-and-deploy test (pending migration — see TODO in
// pull_and_deploy.go).
func calculateGitBlobHash(filePath string) (string, error) {
	// Read file content
	content, err := os.ReadFile(filePath)
	if err != nil {
		return "", err
	}

	// Create blob: "blob <size>\0<content>"
	blobHeader := fmt.Sprintf("blob %d\000", len(content))
	blob := append([]byte(blobHeader), content...)

	// Calculate SHA1 hash
	hasher := sha1.New()
	hasher.Write(blob)
	hash := hex.EncodeToString(hasher.Sum(nil))

	return hash, nil
}

func waitForGitopsReady(gitopsURL, secret, workspaceName string) error {
	// Probe the gitops service directly inside its container instead of through
	// the public URL. The public path crosses Traefik, the protected gate (which
	// redirects unauthenticated requests to OAuth), and host-side localhost
	// resolution that can't follow cross-host redirects — none of which this
	// readiness check cares about. A direct `curl localhost:8079` is
	// deterministic across CI and AOC-connected hosts alike.
	containerName := fmt.Sprintf("%s-site-bitswan-gitops-1", workspaceName)
	const maxAttempts = 90 // ~3 minutes (90 * 2s)

	fmt.Printf("Waiting for gitops container '%s' to be ready...\n", containerName)
	for attempt := 0; attempt < maxAttempts; attempt++ {
		// Trailing slash avoids gitops' 307 redirect on /automations.
		curlCmd := exec.Command("docker", "exec", containerName, "curl", "-s", "-o", "/dev/null",
			"-w", "%{http_code}",
			"-H", fmt.Sprintf("Authorization: Bearer %s", secret),
			"http://localhost:8079/automations/")
		out, err := curlCmd.Output()
		if err == nil {
			// Any real HTTP status (2xx/3xx/4xx) means the server is up and
			// serving; only "000" (no connection) or 5xx mean not-ready-yet.
			code := strings.TrimSpace(string(out))
			if code != "" && code != "000" && !strings.HasPrefix(code, "5") {
				fmt.Printf("Gitops service is ready (HTTP %s)\n", code)
				return nil
			}
			if attempt%10 == 0 {
				fmt.Printf("Gitops not serving yet (HTTP %s, attempt %d/%d)\n", code, attempt+1, maxAttempts)
			}
		} else if attempt%10 == 0 {
			fmt.Printf("Gitops container not reachable yet (attempt %d/%d)\n", attempt+1, maxAttempts)
		}
		time.Sleep(2 * time.Second)
	}

	if logs, err := exec.Command("docker", "logs", containerName, "--tail", "30").CombinedOutput(); err == nil {
		fmt.Printf("Gitops container logs (last 30 lines):\n%s\n", string(logs))
	}
	return fmt.Errorf("gitops service did not become ready within timeout")
}

func uploadAsset(gitopsURL, secret, workspaceName, zipPath, checksum string) error {
	// Open ZIP file
	file, err := os.Open(zipPath)
	if err != nil {
		return err
	}
	defer file.Close()

	// Create multipart form
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)

	// Add file
	part, err := writer.CreateFormFile("file", "deployment.zip")
	if err != nil {
		return err
	}
	if _, err := io.Copy(part, file); err != nil {
		return err
	}

	// Add checksum
	if err := writer.WriteField("checksum", checksum); err != nil {
		return err
	}

	writer.Close()

	// Create request
	url := fmt.Sprintf("%s/automations/assets/upload", gitopsURL)
	url = automations.TransformURLForDaemon(url, workspaceName)
	req, err := httpReq.NewRequest("POST", url, &body)
	if err != nil {
		return err
	}

	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+secret)

	// Send request with localhost resolution
	resp, err := httpReq.ExecuteRequestWithLocalhostResolution(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("upload failed with status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	return nil
}

func buildAutomationImage(gitopsURL, secret, workspaceName, imageName, checksum string) (string, error) {
	// Find the FastAPI example directory in bitswan-src
	homeDir := os.Getenv("HOME")
	if homeDir == "" {
		return "", fmt.Errorf("HOME environment variable not set")
	}

	fastAPIDir := filepath.Join(homeDir, ".config", "bitswan", "bitswan-src", "examples", "FastAPIApp")

	// Check if directory exists
	if _, err := os.Stat(fastAPIDir); os.IsNotExist(err) {
		return "", fmt.Errorf("FastAPI example directory not found at %s. Ensure workspace init has created bitswan-src", fastAPIDir)
	}

	imageDir := filepath.Join(fastAPIDir, "image")
	if _, err := os.Stat(imageDir); os.IsNotExist(err) {
		// No image directory, skip image building
		return "", nil
	}

	// Calculate checksum for image directory
	imageChecksum, err := calculateGitTreeHash(imageDir)
	if err != nil {
		return "", fmt.Errorf("failed to calculate image checksum: %w", err)
	}

	// Create ZIP for image
	tmpFile, err := os.CreateTemp("", "fastapi-image-*.zip")
	if err != nil {
		return "", err
	}
	imageZipPath := tmpFile.Name()
	tmpFile.Close()
	defer os.Remove(imageZipPath)

	// Create ZIP from image directory
	zipFile, err := os.Create(imageZipPath)
	if err != nil {
		return "", err
	}
	defer zipFile.Close()

	zipWriter := zip.NewWriter(zipFile)
	defer zipWriter.Close()

	err = filepath.Walk(imageDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		relPath, _ := filepath.Rel(imageDir, path)
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()
		zipEntry, err := zipWriter.Create(relPath)
		if err != nil {
			return err
		}
		_, err = io.Copy(zipEntry, file)
		return err
	})
	if err != nil {
		return "", fmt.Errorf("failed to create image ZIP: %w", err)
	}
	zipWriter.Close()
	zipFile.Close()

	// Upload image
	file, err := os.Open(imageZipPath)
	if err != nil {
		return "", err
	}
	defer file.Close()

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "image.zip")
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(part, file); err != nil {
		return "", err
	}
	if err := writer.WriteField("checksum", imageChecksum); err != nil {
		return "", err
	}
	writer.Close()

	url := fmt.Sprintf("%s/images/%s", gitopsURL, imageName)
	url = automations.TransformURLForDaemon(url, workspaceName)
	req, err := httpReq.NewRequest("POST", url, &body)
	if err != nil {
		return "", err
	}

	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+secret)

	resp, err := httpReq.ExecuteRequestWithLocalhostResolution(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("image build failed with status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	// Parse response to get image tag
	var buildResponse struct {
		Tag string `json:"tag"`
	}
	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if err := json.Unmarshal(bodyBytes, &buildResponse); err == nil && buildResponse.Tag != "" {
		// Wait for image to be ready
		expectedTag := buildResponse.Tag
		if err := waitForImageReady(gitopsURL, secret, workspaceName, expectedTag); err != nil {
			return "", fmt.Errorf("image build did not complete: %w", err)
		}
		return expectedTag, nil
	}

	return "", nil
}

func waitForImageReady(gitopsURL, secret, workspaceName, expectedTag string) error {
	// Increase timeout for CI environments where image builds may take longer
	// 600 attempts * 2 seconds = 20 minutes
	maxAttempts := 600
	attempt := 0

	fmt.Printf("Waiting for image '%s' to be ready (timeout: %d minutes)...\n", expectedTag, maxAttempts*2/60)

	for attempt < maxAttempts {
		// Use /images/ with trailing slash to avoid 307 redirect that loses Authorization header
		url := fmt.Sprintf("%s/images/", gitopsURL)
		url = automations.TransformURLForDaemon(url, workspaceName)
		req, err := httpReq.NewRequest("GET", url, nil)
		if err != nil {
			if attempt%30 == 0 {
				fmt.Printf("  Error creating request (attempt %d/%d): %v\n", attempt+1, maxAttempts, err)
			}
			time.Sleep(2 * time.Second)
			attempt++
			continue
		}

		req.Header.Set("Authorization", "Bearer "+secret)

		resp, err := httpReq.ExecuteRequestWithLocalhostResolution(req)
		if err != nil {
			if attempt%30 == 0 {
				fmt.Printf("  Error executing request (attempt %d/%d): %v\n", attempt+1, maxAttempts, err)
			}
			time.Sleep(2 * time.Second)
			attempt++
			continue
		}

		if resp.StatusCode == http.StatusOK {
			bodyBytes, err := io.ReadAll(resp.Body)
			resp.Body.Close()
			if err != nil {
				time.Sleep(2 * time.Second)
				attempt++
				continue
			}

			var images []struct {
				Tag         string `json:"tag"`
				BuildStatus string `json:"build_status"`
			}
			if err := json.Unmarshal(bodyBytes, &images); err == nil {
				found := false
				for _, img := range images {
					if img.Tag == expectedTag {
						found = true
						if img.BuildStatus == "ready" || img.BuildStatus == "" {
							fmt.Printf("  Image '%s' is ready!\n", expectedTag)
							return nil
						}
						if img.BuildStatus == "failed" {
							return fmt.Errorf("image build failed")
						}
						// Still building
						if attempt%10 == 0 {
							fmt.Printf("  Waiting for image build... (attempt %d/%d, status: %s)\n", attempt+1, maxAttempts, img.BuildStatus)
						}
					}
				}
				if !found && attempt%30 == 0 {
					fmt.Printf("  Image '%s' not found in images list yet (attempt %d/%d)\n", expectedTag, attempt+1, maxAttempts)
				}
			}
		} else {
			// Read response body for error details
			bodyBytes, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if attempt%30 == 0 || resp.StatusCode == 401 {
				fmt.Printf("  Unexpected status code %d (attempt %d/%d)\n", resp.StatusCode, attempt+1, maxAttempts)
				if len(bodyBytes) > 0 {
					fmt.Printf("  Response body: %s\n", string(bodyBytes))
				}
				if resp.StatusCode == 401 {
					fmt.Printf("  Authentication failed - checking gitops container logs...\n")
					// Try to get gitops container logs
					workspaceNameForLogs := workspaceName
					logsCmd := exec.Command("docker", "logs", "--tail", "50", fmt.Sprintf("%s-site-bitswan-gitops-1", workspaceNameForLogs))
					if logsOutput, err := logsCmd.Output(); err == nil {
						fmt.Printf("  Gitops container logs (last 50 lines):\n%s\n", string(logsOutput))
					}
					// Also check the secret being used
					secretPreview := secret
					if len(secret) > 10 {
						secretPreview = secret[:10]
					}
					fmt.Printf("  Using secret from metadata (first 10 chars): %s...\n", secretPreview)
				}
			}
		}

		time.Sleep(2 * time.Second)
		attempt++
	}

	return fmt.Errorf("image did not become ready within timeout")
}

func deployAutomation(gitopsURL, secret, workspaceName, deploymentID, checksum string) error {
	// Create form data
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)

	writer.WriteField("checksum", checksum)
	writer.WriteField("stage", "dev")
	writer.WriteField("relative_path", "")
	writer.Close()

	// Create request
	url := fmt.Sprintf("%s/automations/%s/deploy", gitopsURL, deploymentID)
	url = automations.TransformURLForDaemon(url, workspaceName)
	req, err := httpReq.NewRequest("POST", url, &body)
	if err != nil {
		return err
	}

	req.Header.Set("Content-Type", writer.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+secret)

	// Send request with localhost resolution
	resp, err := httpReq.ExecuteRequestWithLocalhostResolution(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusAccepted {
		bodyBytes, _ := io.ReadAll(resp.Body)
		// Try to parse error details
		var errorResp struct {
			Detail string `json:"detail"`
		}
		if json.Unmarshal(bodyBytes, &errorResp) == nil && errorResp.Detail != "" {
			return fmt.Errorf("deploy failed with status %d: %s", resp.StatusCode, errorResp.Detail)
		}
		return fmt.Errorf("deploy failed with status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	return nil
}

func waitForDeployment(gitopsURL, secret, workspaceName, deploymentID string) (string, error) {
	// The container should reach "running" within seconds of the deploy task
	// completing; 3 minutes is a generous margin for CI.
	maxAttempts := 90 // 3 minutes (90 * 2 seconds)
	attempt := 0

	fmt.Printf("Waiting for deployment '%s' to be ready (timeout: %d minutes)...\n", deploymentID, maxAttempts*2/60)

	for attempt < maxAttempts {
		// Get automation status
		// Use /automations/ with trailing slash to avoid 307 redirect that loses Authorization header
		reqURL := fmt.Sprintf("%s/automations/", gitopsURL)
		reqURL = automations.TransformURLForDaemon(reqURL, workspaceName)

		// Log the request details
		if attempt%5 == 0 || attempt < 3 {
			fmt.Printf("  [Attempt %d/%d] GET %s\n", attempt+1, maxAttempts, reqURL)
		}

		req, err := httpReq.NewRequest("GET", reqURL, nil)
		if err != nil {
			if attempt%5 == 0 || attempt < 3 {
				fmt.Printf("  Error creating request: %v\n", err)
			}
			time.Sleep(2 * time.Second)
			attempt++
			continue
		}

		req.Header.Set("Authorization", "Bearer "+secret)

		resp, err := httpReq.ExecuteRequestWithLocalhostResolution(req)
		if err != nil {
			if attempt%5 == 0 || attempt < 3 {
				fmt.Printf("  Error executing request: %v\n", err)
			}
			time.Sleep(2 * time.Second)
			attempt++
			continue
		}

		// Log response status
		if attempt%5 == 0 || attempt < 3 {
			fmt.Printf("  Response: %d %s\n", resp.StatusCode, resp.Status)
		}

		if resp.StatusCode == http.StatusOK {
			bodyBytes, err := io.ReadAll(resp.Body)
			resp.Body.Close()

			if err != nil {
				if attempt%5 == 0 || attempt < 3 {
					fmt.Printf("  Error reading response body: %v\n", err)
				}
				time.Sleep(2 * time.Second)
				attempt++
				continue
			}

			// Log response body for first few attempts or periodically
			if attempt < 3 || attempt%10 == 0 {
				bodyPreview := string(bodyBytes)
				if len(bodyPreview) > 500 {
					bodyPreview = bodyPreview[:500] + "..."
				}
				fmt.Printf("  Response body: %s\n", bodyPreview)
			}

			// Parse JSON response to find our automation
			var automations []struct {
				DeploymentID  string `json:"deployment_id"`
				State         string `json:"state"`
				EndpointName  string `json:"endpoint_name"`
				AutomationURL string `json:"automation_url"`
			}

			if err := json.Unmarshal(bodyBytes, &automations); err == nil {
				// Find our automation
				found := false
				for _, auto := range automations {
					if auto.DeploymentID == deploymentID {
						found = true
						// Log every attempt when we find the automation
						if attempt%5 == 0 {
							fmt.Printf("  Found automation '%s': state=%s, endpoint_name=%s (attempt %d/%d)\n", deploymentID, auto.State, auto.EndpointName, attempt+1, maxAttempts)
						}
						// Check if it's running
						if auto.State == "running" {
							// Use automation_url if available, otherwise construct from endpoint_name
							endpointURL := auto.AutomationURL
							if endpointURL == "" && auto.EndpointName != "" {
								// Construct URL from gitops URL and endpoint name
								// Format: https://{workspace}-gitops.{domain}/{endpoint_name}
								parsedURL, err := url.Parse(gitopsURL)
								if err == nil {
									endpointURL = fmt.Sprintf("%s://%s/%s", parsedURL.Scheme, parsedURL.Host, auto.EndpointName)
								} else {
									if attempt%10 == 0 {
										fmt.Printf("  Failed to parse gitops URL: %v\n", err)
									}
								}
							}
							if endpointURL != "" {
								fmt.Printf("  Deployment ready! URL: %s\n", endpointURL)
								// Give it a moment to fully start
								time.Sleep(3 * time.Second)
								return endpointURL, nil
							} else {
								// If running but no URL available yet, log and continue waiting
								if attempt%5 == 0 {
									fmt.Printf("  Deployment is running but URL not available (attempt %d/%d, state: %s, endpoint_name: %s, automation_url: %s)\n", attempt+1, maxAttempts, auto.State, auto.EndpointName, auto.AutomationURL)
								}
							}
						} else {
							// If automation exists but isn't running yet, continue waiting
							// (it might be building the image)
							// Log progress every 5 attempts (10 seconds)
							if attempt%5 == 0 {
								fmt.Printf("  Waiting for deployment... (attempt %d/%d, state: %s, endpoint_name: %s)\n", attempt+1, maxAttempts, auto.State, auto.EndpointName)
							}
						}
					}
				}
				// If we didn't find the automation at all, log it more frequently
				if !found {
					if attempt%10 == 0 {
						fmt.Printf("  Automation '%s' not found in list (attempt %d/%d, found %d automations)\n", deploymentID, attempt+1, maxAttempts, len(automations))
					}
				}
			} else {
				// Log parse errors more frequently
				if attempt%10 == 0 {
					fmt.Printf("  Failed to parse automations response (attempt %d/%d): %v\n", attempt+1, maxAttempts, err)
					bodyPreview := string(bodyBytes)
					if len(bodyPreview) > 500 {
						bodyPreview = bodyPreview[:500]
					}
					fmt.Printf("  Response body (first 500 chars): %s\n", bodyPreview)
				}
			}
		} else {
			// Log non-200 responses
			bodyBytes, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if attempt%5 == 0 || attempt < 3 {
				bodyPreview := string(bodyBytes)
				if len(bodyPreview) > 500 {
					bodyPreview = bodyPreview[:500] + "..."
				}
				fmt.Printf("  Unexpected status code %d: %s\n", resp.StatusCode, bodyPreview)
			}
		}

		time.Sleep(2 * time.Second)
		attempt++
	}

	return "", fmt.Errorf("deployment did not become ready within timeout")
}

func testEndpoint(endpointURL, workspaceName string) error {
	// Test the root endpoint
	// Transform URL for daemon if needed
	url := automations.TransformURLForDaemon(endpointURL, workspaceName)
	req, err := httpReq.NewRequest("GET", url, nil)
	if err != nil {
		return err
	}

	resp, err := httpReq.ExecuteRequestWithLocalhostResolution(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("endpoint returned status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	// Check if response contains expected content (FastAPI returns JSON like {"ok": true})
	bodyStr := string(bodyBytes)
	if !strings.Contains(bodyStr, "ok") && !strings.Contains(bodyStr, "Hello") {
		return fmt.Errorf("unexpected response: %s", bodyStr)
	}

	return nil
}

func removeAutomation(gitopsURL, secret, workspaceName, deploymentID string) error {
	url := fmt.Sprintf("%s/automations/%s", gitopsURL, deploymentID)
	url = automations.TransformURLForDaemon(url, workspaceName)
	req, err := httpReq.NewRequest("DELETE", url, nil)
	if err != nil {
		return err
	}

	req.Header.Set("Authorization", "Bearer "+secret)

	resp, err := httpReq.ExecuteRequestWithLocalhostResolution(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("remove failed with status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	return nil
}

func cleanupWorkspace(workspaceName string) error {
	client, err := daemon.NewClient()
	if err != nil {
		return err
	}

	return client.WorkspaceRemove(workspaceName)
}

// verifyGitServer exercises the workspace's embedded fast-forward-only git
// server: it clones the canonical repo over smart-HTTP, fast-forward-pushes a
// commit (must succeed), then rewrites history and force-pushes (must be
// rejected by the pre-receive hook). Credentials are the gitops secret, which
// the git server accepts via HTTP Basic.
func verifyGitServer(gitopsURL, secret, repoPath string) error {
	u, err := url.Parse(gitopsURL)
	if err != nil {
		return fmt.Errorf("parse gitops url: %w", err)
	}
	u.User = url.UserPassword("x", secret)
	u.Path = repoPath
	gitURL := u.String()

	tmp, err := os.MkdirTemp("", "gitsrv-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	work := filepath.Join(tmp, "work")

	// Each git op talks to an idle local git server, so it should complete in
	// seconds. Bound every call so a server-side stall fails loudly with the
	// offending command rather than hanging the whole job until its timeout.
	runGit := func(args ...string) (string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "git", args...)
		cmd.Env = append(os.Environ(),
			"GIT_TERMINAL_PROMPT=0",
			"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@bitswan.local",
			"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@bitswan.local",
		)
		out, err := cmd.CombinedOutput()
		if ctx.Err() == context.DeadlineExceeded {
			return string(out), fmt.Errorf("git %s timed out after 120s (server stalled): %s", strings.Join(args, " "), out)
		}
		return string(out), err
	}

	if out, err := runGit("clone", gitURL, work); err != nil {
		return fmt.Errorf("clone failed: %w: %s", err, out)
	}
	if out, err := runGit("-C", work, "checkout", "-b", "git-server-test-branch"); err != nil {
		return fmt.Errorf("branch: %w: %s", err, out)
	}
	if err := os.WriteFile(filepath.Join(work, "git-server-test.txt"), []byte("ok\n"), 0644); err != nil {
		return err
	}
	if out, err := runGit("-C", work, "add", "-A"); err != nil {
		return fmt.Errorf("git add: %w: %s", err, out)
	}
	if out, err := runGit("-C", work, "commit", "-m", "git server ff test"); err != nil {
		return fmt.Errorf("git commit: %w: %s", err, out)
	}
	// main is deploy-only: a direct push to it must be rejected — it only
	// advances server-side via the user-gated deploy, never by a client push.
	if out, err := runGit("-C", work, "push", "origin", "HEAD:refs/heads/main"); err == nil {
		return fmt.Errorf("push to protected main was accepted but must be rejected: %s", out)
	}
	// Work goes on a copy branch: creating it and fast-forwarding it are allowed.
	if out, err := runGit("-C", work, "push", "origin", "HEAD:refs/heads/git-server-test"); err != nil {
		return fmt.Errorf("copy-branch creation push was rejected unexpectedly: %w: %s", err, out)
	}
	if err := os.WriteFile(filepath.Join(work, "git-server-test2.txt"), []byte("ok2\n"), 0644); err != nil {
		return err
	}
	if out, err := runGit("-C", work, "add", "-A"); err != nil {
		return fmt.Errorf("git add: %w: %s", err, out)
	}
	if out, err := runGit("-C", work, "commit", "-m", "git server ff test 2"); err != nil {
		return fmt.Errorf("git commit: %w: %s", err, out)
	}
	if out, err := runGit("-C", work, "push", "origin", "HEAD:refs/heads/git-server-test"); err != nil {
		return fmt.Errorf("fast-forward push to a copy branch was rejected unexpectedly: %w: %s", err, out)
	}
	// Rewrite the just-pushed commit and force-push — the server must reject it.
	if out, err := runGit("-C", work, "commit", "--amend", "-m", "rewritten"); err != nil {
		return fmt.Errorf("git amend: %w: %s", err, out)
	}
	if out, err := runGit("-C", work, "push", "-f", "origin", "HEAD:refs/heads/git-server-test"); err == nil {
		return fmt.Errorf("force-push was accepted but must be rejected (fast-forward-only): %s", out)
	}
	return nil
}

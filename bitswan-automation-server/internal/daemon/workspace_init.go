package daemon

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"gopkg.in/yaml.v3"

	"github.com/bitswan-space/bitswan-workspaces/internal/aoc"
	"github.com/bitswan-space/bitswan-workspaces/internal/caddyapi"
	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/docker"
	"github.com/bitswan-space/bitswan-workspaces/internal/dockercompose"
	"github.com/bitswan-space/bitswan-workspaces/internal/dockerhub"
	"github.com/bitswan-space/bitswan-workspaces/internal/oauth"
	"github.com/bitswan-space/bitswan-workspaces/internal/services"
	"github.com/bitswan-space/bitswan-workspaces/internal/ssh"
	"github.com/bitswan-space/bitswan-workspaces/internal/traefikapi"
	"github.com/bitswan-space/bitswan-workspaces/internal/util"
)

// runWorkspaceInit runs the workspace init logic with stdout already redirected.
// confirmCh is used to block until the client confirms the SSH key prompt.
func (s *Server) runWorkspaceInit(args []string, confirmCh <-chan struct{}) error {
	// Parse flags
	fs := flag.NewFlagSet("workspace-init", flag.ContinueOnError)
	remoteRepo := fs.String("remote", "", "")
	workspaceBranch := fs.String("branch", "", "")
	domain := fs.String("domain", "", "")
	certsDir := fs.String("certs-dir", "", "")
	verbose := fs.Bool("verbose", false, "")
	mkCerts := fs.Bool("mkcerts", false, "")
	noDashboard := fs.Bool("no-dashboard", false, "")
	noCodingAgent := fs.Bool("no-coding-agent", false, "")
	setHosts := fs.Bool("set-hosts", false, "")
	local := fs.Bool("local", false, "")
	gitopsImage := fs.String("gitops-image", "", "")
	dashboardImage := fs.String("dashboard-image", "", "")
	codingAgentImage := fs.String("coding-agent-image", "", "")
	gitopsDevSourceDir := fs.String("gitops-dev-source-dir", "", "")
	dashboardDevSourceDir := fs.String("dashboard-dev-source-dir", "", "")
	codingAgentDevSourceDir := fs.String("coding-agent-dev-source-dir", "", "")
	oauthConfigFile := fs.String("oauth-config", "", "")
	noOauth := fs.Bool("no-oauth", false, "")
	sshPort := fs.String("ssh-port", "", "")
	staging := fs.Bool("staging", false, "")
	// Email of the user creating the workspace. Passed through to
	// route registration so the workspace's endpoints (gitops,
	// dashboard) are recorded under this owner in the Bailey ACL.
	owner := fs.String("owner", "", "")

	if err := fs.Parse(args); err != nil {
		return fmt.Errorf("failed to parse flags: %w", err)
	}

	if len(fs.Args()) < 1 {
		return fmt.Errorf("workspace name is required")
	}

	workspaceName := fs.Args()[0]
	bitswanConfig := os.Getenv("HOME") + "/.config/bitswan/"
	var err error

	// The daemon is a long-lived process. Init shells out to `docker compose`
	// from the deployment dir via os.Chdir below, which mutates the daemon's
	// process-global CWD. If we left it parked inside this workspace's
	// directory and the workspace were later removed (rm -rf), the daemon's CWD
	// would become an unlinked directory — and the next command that calls
	// getcwd() (notably `git clone` with no -C, during a same-name re-init)
	// fails with "fatal: unable to read current working directory" (exit 128)
	// until the daemon is restarted. Restore the original CWD on return so a
	// removed workspace can never strand the daemon in a dead directory.
	if origWD, wdErr := os.Getwd(); wdErr == nil {
		defer func() {
			if cerr := os.Chdir(origWD); cerr != nil {
				fmt.Printf("Warning: failed to restore working directory to %s: %v\n", origWD, cerr)
			}
		}()
	}

	if err := os.MkdirAll(bitswanConfig, 0755); err != nil {
		return fmt.Errorf("failed to create BitSwan config directory: %w", err)
	}

	// Init bitswan network
	docker.EnsureDockerNetwork("bitswan_network", *verbose)

	var oauthConfig *oauth.Config
	if *oauthConfigFile != "" {
		oauthConfig, err = oauth.GetInitOauthConfig(*oauthConfigFile)
		if err != nil {
			return fmt.Errorf("failed to get OAuth config: %w", err)
		}
		fmt.Println("OAuth config read successfully!")
	}

	// Ensure the global ingress proxy is running.
	// initIngress is idempotent: it detects Caddy or Traefik and returns early if already running.
	if _, err := initIngress(*verbose); err != nil {
		return fmt.Errorf("failed to initialize ingress: %w", err)
	}
	fmt.Println("Ingress proxy is ready!")

	// Handle --local flag
	if *local && (*setHosts || *mkCerts) {
		return fmt.Errorf("cannot use --local flag with --set-hosts or --mkcerts")
	}

	if *local {
		*setHosts = true
		*mkCerts = true
		if *domain == "" {
			*domain = fmt.Sprintf("bs-%s.localhost", workspaceName)
		}
	}

	// When neither --domain nor --local supplies a domain, fall back to the
	// server's configured domain so operators on an AOC-registered server
	// don't have to re-type a domain the daemon already knows. LoadConfig
	// failure (no config file) is non-fatal: resolveWorkspaceInitDomain then
	// leaves the domain empty, preserving today's behavior.
	var initCfg *config.Config
	if cfg, cfgErr := config.NewAutomationServerConfig().LoadConfig(); cfgErr == nil {
		initCfg = cfg
	}
	if resolved := resolveWorkspaceInitDomain(*domain, *local, initCfg); resolved != *domain {
		*domain = resolved
		fmt.Printf("No --domain provided; defaulting to the server's configured domain: %s\n", *domain)
	}

	// Handle certificate generation and installation
	if *mkCerts || *certsDir != "" {
		ingressType := DetectIngressType()
		switch ingressType {
		case IngressCaddy:
			if *mkCerts {
				if err := caddyapi.GenerateAndInstallCerts(*domain); err != nil {
					return fmt.Errorf("error generating and installing certificates: %w", err)
				}
			} else if *certsDir != "" {
				caddyCfg := bitswanConfig + "caddy"
				if err := caddyapi.InstallCertsFromDir(*certsDir, *domain, caddyCfg); err != nil {
					return fmt.Errorf("error installing certificates from directory: %w", err)
				}
			}
		case IngressTraefik:
			if *mkCerts {
				// Generate wildcard cert for *.domain so subdomains (gitops, editor, automations) are covered
				wildcardHostname := "*." + *domain
				if err := traefikapi.InstallTLSCerts(wildcardHostname, true, ""); err != nil {
					return fmt.Errorf("error installing wildcard certificates: %w", err)
				}
			} else if *certsDir != "" {
				if err := traefikapi.InstallTLSCerts(*domain, false, *certsDir); err != nil {
					return fmt.Errorf("error installing certificates from directory: %w", err)
				}
			}
		}
	}

	gitopsConfig := bitswanConfig + "workspaces/" + workspaceName

	if _, err := os.Stat(gitopsConfig); !os.IsNotExist(err) {
		return fmt.Errorf("GitOps with this name was already initialized: %s", workspaceName)
	}

	if err := os.MkdirAll(gitopsConfig, 0755); err != nil {
		return fmt.Errorf("failed to create GitOps directory: %w", err)
	}

	// Pre-create the workspace's standard data subdirectories. The compose
	// mounts them as named-volume subpaths, which Docker requires to exist
	// before the container starts (unlike bind mounts, which auto-create the
	// source). Created before the recursive chown below so they inherit
	// user1000 ownership. (e.g. secrets, snapshots — missing these makes the
	// gitops container fail to start with "cannot access path .../snapshots".)
	ensureWorkspaceVolumeDirs(workspaceName)

	// Ensure user1000 exists (create if it doesn't)
	checkUserCmd := exec.Command("id", "-u", "1000")
	if checkUserCmd.Run() != nil {
		// User doesn't exist, create it
		createUserCmd := exec.Command("useradd", "-u", "1000", "-m", "-s", "/bin/sh", "user1000")
		createUserCmd.Run() // Ignore errors, might already exist
	}

	// Ensure the entire path is accessible to user1000 by chowning parent directories
	// Chown /root/.config/bitswan to ensure user1000 can access workspaces
	// Also need to ensure /root is accessible (at least execute permission)
	chownRootCmd := exec.Command("chmod", "755", "/root")
	chownRootCmd.Run() // Ignore errors
	chownRootConfigCmd := exec.Command("chmod", "755", "/root/.config")
	chownRootConfigCmd.Run() // Ignore errors

	bitswanConfigDir := bitswanConfig
	chownBitswanCmd := exec.Command("chown", "-R", "1000:1000", bitswanConfigDir)
	chownBitswanCmd.Run() // Ignore errors, might already be correct

	// Ensure the directory is owned by user1000 from the start
	chownConfigCmd := exec.Command("chown", "-R", "1000:1000", gitopsConfig)
	if err := chownConfigCmd.Run(); err != nil {
		return fmt.Errorf("failed to chown gitops config directory: %w", err)
	}

	// Initialize Bitswan workspace
	gitopsWorkspace := gitopsConfig + "/workspace"
	var localRemoteName string
	var localRemotePath string
	if *remoteRepo != "" {
		// Check if this is a local file path (starts with / or file://)
		isLocalPath := strings.HasPrefix(*remoteRepo, "/") || strings.HasPrefix(*remoteRepo, "file://")

		if isLocalPath {
			// Handle local file path - clone directly without SSH setup
			clonePath := *remoteRepo
			if strings.HasPrefix(clonePath, "file://") {
				clonePath = strings.TrimPrefix(clonePath, "file://")
			}

			fmt.Println("Cloning local repository...")
			// Run git clone as user1000 to ensure the cloned repository is owned by user1000
			// Use su to switch to user1000 for git operations
			// Escape the paths for shell safety
			com := exec.Command("su", "-s", "/bin/sh", "user1000", "-c", fmt.Sprintf("git clone %q %q", clonePath, gitopsWorkspace)) //nolint:gosec
			if err := util.RunCommandVerbose(com, *verbose); err != nil {
				return fmt.Errorf("failed to clone local repository: %w", err)
			}
			fmt.Println("Local repository cloned!")

			// For local remotes, we need to mount the repository in the GitOps container
			// so it can fetch from it. Determine the host path and mount name.
			hostHomeDir := os.Getenv("HOST_HOME")

			if strings.HasPrefix(clonePath, "/root/.config/bitswan/workspaces/") {
				// Extract workspace name from path: /root/.config/bitswan/workspaces/<workspace-name>/workspace
				parts := strings.Split(strings.TrimPrefix(clonePath, "/root/.config/bitswan/workspaces/"), "/")
				if len(parts) >= 1 && parts[0] != "" {
					localRemoteName = parts[0]
					// Get the host path for the local repository
					if hostHomeDir != "" {
						localRemotePath = filepath.Join(hostHomeDir, ".config", "bitswan", "workspaces", localRemoteName, "workspace")
						// Store the mount point URL for later (after push)
						// We'll update the remote URL after the push succeeds
						fmt.Printf("Detected workspace repository remote. Will update remote URL after push to: /remote-repos/%s\n", localRemoteName)
					} else {
						fmt.Printf("Warning: HOST_HOME not set, cannot set up local remote mount\n")
					}
				}
			} else {
				// For other local paths, we need to mount them too so GitOps can access them
				// Convert container path to host path if needed
				if hostHomeDir != "" && strings.HasPrefix(clonePath, "/root/.config/bitswan/") {
					// Convert container path to host path
					relativePath := strings.TrimPrefix(clonePath, "/root/.config/bitswan")
					localRemotePath = filepath.Join(hostHomeDir, ".config", "bitswan") + relativePath
					// Use a generic mount point name
					localRemoteName = "remote-repo"
					// Update remote URL to use mount point
					remoteURLForGitOps := filepath.Join("/remote-repos", "remote-repo")
					fmt.Printf("Detected local repository remote. Will update remote URL after push to: %s\n", remoteURLForGitOps)
				} else if strings.HasPrefix(clonePath, "/host/") {
					// Already a /host/ path, use it directly
					localRemotePath = clonePath
					localRemoteName = "remote-repo"
					remoteURLForGitOps := strings.TrimPrefix(clonePath, "/host")
					fmt.Printf("Detected /host/ path remote. Will update remote URL after push to: %s\n", remoteURLForGitOps)
				} else {
					// Absolute path on host, use as-is
					localRemotePath = clonePath
					localRemoteName = "remote-repo"
					remoteURLForGitOps := filepath.Join("/remote-repos", "remote-repo")
					fmt.Printf("Detected local path remote. Will update remote URL after push to: %s\n", remoteURLForGitOps)
				}
			}

			// Checkout specified branch if provided
			if *workspaceBranch != "" {
				fmt.Printf("Checking out branch '%s'...\n", *workspaceBranch)
				// First check if branch exists - run as user1000
				checkBranchCmd := exec.Command("su", "-s", "/bin/sh", "user1000", "-c", fmt.Sprintf("cd %s && git rev-parse --verify origin/%s", gitopsWorkspace, *workspaceBranch)) //nolint:gosec
				if checkBranchCmd.Run() == nil {
					// Branch exists in remote, checkout it
					checkoutCom := exec.Command("su", "-s", "/bin/sh", "user1000", "-c", fmt.Sprintf("cd %s && git checkout -b %s origin/%s", gitopsWorkspace, *workspaceBranch, *workspaceBranch)) //nolint:gosec
					if err := util.RunCommandVerbose(checkoutCom, *verbose); err != nil {
						// Try just checking out if branch already exists locally
						checkoutCom = exec.Command("su", "-s", "/bin/sh", "user1000", "-c", fmt.Sprintf("cd %s && git checkout %s", gitopsWorkspace, *workspaceBranch)) //nolint:gosec
						if err := util.RunCommandVerbose(checkoutCom, *verbose); err != nil {
							fmt.Printf("Warning: Failed to checkout branch '%s': %v\n", *workspaceBranch, err)
							fmt.Printf("Continuing with the default branch...\n")
						} else {
							fmt.Printf("Successfully checked out branch '%s'!\n", *workspaceBranch)
						}
					} else {
						fmt.Printf("Successfully checked out branch '%s'!\n", *workspaceBranch)
					}
				} else {
					// Branch doesn't exist in remote, it will be created as orphan branch later
					fmt.Printf("Branch '%s' does not exist in remote, will be created as orphan branch\n", *workspaceBranch)
				}
			}
		} else {
			// Generate SSH key pair for the workspace before cloning
			fmt.Println("Generating SSH key pair for workspace...")
			sshKeyPair, err := ssh.GenerateSSHKeyPair(gitopsConfig)
			if err != nil {
				return fmt.Errorf("failed to generate SSH key pair: %w", err)
			}
			fmt.Printf("SSH key pair generated: %s\n", sshKeyPair.PublicKeyPath)

			// Ensure SSH keys are accessible by user1000 (ssh-keygen runs as root)
			chownSSHCmd := exec.Command("chown", "-R", "1000:1000", filepath.Join(gitopsConfig, "ssh"))
			chownSSHCmd.Run() // Ignore errors

			// Parse repository URL to get hostname, org, and repo
			repoInfo, err := parseRepositoryURL(*remoteRepo)
			if err != nil {
				return fmt.Errorf("failed to parse repository URL: %w", err)
			}

			// Display the public key and wait for user confirmation
			fmt.Println("\n" + strings.Repeat("=", 60))
			fmt.Println("IMPORTANT: SSH Key Setup Required")
			fmt.Println(strings.Repeat("=", 60))
			fmt.Printf("Your SSH public key is:\n\n%s\n", sshKeyPair.PublicKey)
			fmt.Println("\nPlease add this key as a deploy key to your repository:")
			fmt.Printf("Repository: %s/%s\n", repoInfo.Org, repoInfo.Repo)
			fmt.Println("\nSteps:")
			fmt.Println("1. Go to your repository settings")
			fmt.Println("2. Navigate to Deploy keys section")
			fmt.Println("3. Add a new deploy key")
			fmt.Println("4. Paste the public key above")
			fmt.Println("5. Give it a descriptive name (e.g., 'bitswan-workspace')")
			fmt.Println("6. Make sure to check 'Allow write access' if you plan to push changes")
			fmt.Println("\nPress ENTER to continue once you've added the deploy key...")

			// Send a "prompt" log entry via the stdout pipe so the client knows to wait for user input
			fmt.Printf("%sPress ENTER to continue once you've added the deploy key...\n", PromptPrefix)

			// Block until the client confirms via /workspace/init/confirm
			<-confirmCh

			var cloneURL string
			// Clone using SSH key as user1000
			cloneURL = fmt.Sprintf("git@%s:%s/%s.git", repoInfo.Hostname, repoInfo.Org, repoInfo.Repo)

			// Build SSH command
			var sshCmd string
			if *sshPort != "" {
				// Create SSH config file for custom port access
				sshConfigPath, err := createSSHConfig(gitopsConfig, workspaceName, repoInfo, *sshPort)
				if err != nil {
					return fmt.Errorf("failed to create SSH config: %w", err)
				}
				// Replace hostname with our SSH config host
				cloneURL = fmt.Sprintf("ssh://git@git-%s/%s/%s.git", workspaceName, repoInfo.Org, repoInfo.Repo)
				sshCmd = fmt.Sprintf("GIT_SSH_COMMAND='ssh -F %s -o StrictHostKeyChecking=no' git clone %s %s", sshConfigPath, cloneURL, gitopsWorkspace)
			} else {
				// Set up SSH to use the generated key directly
				sshCmd = fmt.Sprintf("GIT_SSH_COMMAND='ssh -i %s -o StrictHostKeyChecking=no' git clone %s %s", sshKeyPair.PrivateKeyPath, cloneURL, gitopsWorkspace)
			}

			com := exec.Command("su", "-s", "/bin/sh", "user1000", "-c", sshCmd) //nolint:gosec

			fmt.Println("Cloning remote repository...")
			if err := util.RunCommandVerbose(com, *verbose); err != nil {
				return fmt.Errorf("failed to clone remote repository: %w", err)
			}
			fmt.Println("Remote repository cloned!")

			// Ensure the cloned repository is owned by user1000
			chownCloneCmd := exec.Command("chown", "-R", "1000:1000", gitopsWorkspace)
			chownCloneCmd.Run() // Ignore errors

			// Checkout specified branch if provided
			if *workspaceBranch != "" {
				fmt.Printf("Checking out branch '%s'...\n", *workspaceBranch)
				checkoutCom := exec.Command("su", "-s", "/bin/sh", "user1000", "-c", fmt.Sprintf("cd %s && git checkout %s", gitopsWorkspace, *workspaceBranch)) //nolint:gosec
				if err := util.RunCommandVerbose(checkoutCom, *verbose); err != nil {
					fmt.Printf("Warning: Failed to checkout branch '%s': %v\n", *workspaceBranch, err)
					fmt.Printf("Continuing with the default branch...\n")
				} else {
					fmt.Printf("Successfully checked out branch '%s'!\n", *workspaceBranch)
				}
			}
		}
	} else {
		if err := os.MkdirAll(gitopsWorkspace, 0755); err != nil {
			return fmt.Errorf("failed to create GitOps workspace directory %s: %w", gitopsWorkspace, err)
		}
		// Ensure the workspace directory is owned by user1000
		chownWorkspaceCmd := exec.Command("chown", "-R", "1000:1000", gitopsWorkspace)
		if err := chownWorkspaceCmd.Run(); err != nil {
			return fmt.Errorf("failed to chown workspace directory: %w", err)
		}

		// Run git init as user1000 using -C flag to avoid cd issues
		com := exec.Command("su", "-s", "/bin/sh", "user1000", "-c", fmt.Sprintf("git -C %s init", gitopsWorkspace)) //nolint:gosec
		fmt.Println("Initializing git in workspace...")

		if err := util.RunCommandVerbose(com, *verbose); err != nil {
			return fmt.Errorf("failed to init git in workspace: %w", err)
		}

		fmt.Println("Git initialized in workspace!")
	}

	// Configure git user globally as user1000 (needed for commits)
	gitConfigGlobalCmd := exec.Command("su", "-s", "/bin/sh", "user1000", "-c", "git config --global user.name 'BitSwan Workspace'") //nolint:gosec
	gitConfigGlobalCmd.Run()                                                                                                         // Ignore errors, might already be set

	gitConfigGlobalCmd = exec.Command("su", "-s", "/bin/sh", "user1000", "-c", "git config --global user.email 'workspace@bitswan.local'") //nolint:gosec
	gitConfigGlobalCmd.Run()                                                                                                               // Ignore errors, might already be set

	// GitOps deploy STATE lives on its own disjoint branch (bitswan.yaml only),
	// separate from the source on `main`. It used to be a git WORKTREE of the
	// workspace repo, relying on that repo's `.git` being bind-mounted into the
	// gitops container. Commit 490ff63 ("Replace shared-.git worktrees with a
	// ff-only git server + per-copy clones") stopped mounting that `.git` (and
	// dropped the orphan-worktree gitdir rewrite) when it moved `main` to
	// repo.git/copies — but it never migrated THIS state branch, so the worktree's
	// gitdir pointed at an unmounted path and every in-container git op failed
	// (deploy history never rendered → "Not deployed yet"; BP creation 400s).
	//
	// Make it a SELF-CONTAINED repo on the same disjoint branch so its git works
	// regardless of what's mounted (only /gitops/gitops itself is). Mirror the
	// workspace repo's origin, if any, so the remote-repo push path below still
	// works; the empty state branch is fine — the first deploy writes bitswan.yaml.
	gitopsWorktree := gitopsConfig + "/gitops"
	initStateRepo := fmt.Sprintf(
		"mkdir -p %[1]s && git -C %[1]s init -q -b %[2]s && "+
			"O=$(git -C %[3]s remote get-url origin 2>/dev/null || true); "+
			"[ -n \"$O\" ] && git -C %[1]s remote add origin \"$O\" || true",
		gitopsWorktree, workspaceName, gitopsWorkspace)
	worktreeAddCom := exec.Command("su", "-s", "/bin/sh", "user1000", "-c", initStateRepo) //nolint:gosec

	fmt.Println("Setting up GitOps state repo...")
	if err := util.RunCommandVerbose(worktreeAddCom, *verbose); err != nil {
		return fmt.Errorf("failed to create GitOps state repo: %w", err)
	}

	if *remoteRepo != "" {
		// Check if this is a local file path
		isLocalPath := strings.HasPrefix(*remoteRepo, "/") || strings.HasPrefix(*remoteRepo, "file://")

		// Create empty commit as user1000
		emptyCommitCom := exec.Command("su", "-s", "/bin/sh", "user1000", "-c", fmt.Sprintf("cd %s && git commit --allow-empty -m 'Initial commit'", gitopsWorktree)) //nolint:gosec
		if err := util.RunCommandVerbose(emptyCommitCom, *verbose); err != nil {
			return fmt.Errorf("failed to create empty commit: %w", err)
		}

		if isLocalPath {
			// For local paths, just push directly without SSH setup as user1000
			setUpstreamCom := exec.Command("su", "-s", "/bin/sh", "user1000", "-c", fmt.Sprintf("cd %s && git push -u origin %s", gitopsWorktree, workspaceName)) //nolint:gosec
			if err := util.RunCommandVerbose(setUpstreamCom, *verbose); err != nil {
				return fmt.Errorf("failed to set upstream: %w", err)
			}

			// If this is a local remote, update the remote URL to use the mount point
			// after the push succeeds (so GitOps containers can fetch from it)
			if localRemoteName != "" && localRemotePath != "" {
				var remoteURLForGitOps string
				// Determine the mount point path based on the mount name
				// All local remotes are mounted to /remote-repos/<name>
				remoteURLForGitOps = filepath.Join("/remote-repos", localRemoteName)
				fmt.Printf("Updating remote URL to mount point: %s\n", remoteURLForGitOps)
				// Update in both the main workspace repo and the gitops worktree (they share the same remote config)
				// Update in main workspace repo
				updateRemoteCmd := exec.Command("su", "-s", "/bin/sh", "user1000", "-c", fmt.Sprintf("cd %s && git remote set-url origin %s", gitopsWorkspace, remoteURLForGitOps)) //nolint:gosec
				if err := util.RunCommandVerbose(updateRemoteCmd, *verbose); err != nil {
					fmt.Printf("Warning: Failed to update remote URL to mount point in main repo: %v\n", err)
				}
				// Also update in gitops worktree explicitly (though they share .git, being explicit helps)
				updateRemoteCmdWorktree := exec.Command("su", "-s", "/bin/sh", "user1000", "-c", fmt.Sprintf("cd %s && git remote set-url origin %s", gitopsWorktree, remoteURLForGitOps)) //nolint:gosec
				if err := util.RunCommandVerbose(updateRemoteCmdWorktree, *verbose); err != nil {
					fmt.Printf("Warning: Failed to update remote URL to mount point in worktree: %v\n", err)
				} else {
					fmt.Printf("Remote URL updated to mount point successfully\n")
				}
			}
		} else {
			// Push to remote using SSH key as user1000
			var sshCmd string
			if *sshPort != "" {
				// Parse repository URL to get hostname, org, and repo
				repoInfo, err := parseRepositoryURL(*remoteRepo)
				if err != nil {
					return fmt.Errorf("failed to parse repository URL: %w", err)
				}

				// Create SSH config file for custom port access
				sshConfigPath, err := createSSHConfig(gitopsConfig, workspaceName, repoInfo, *sshPort)
				if err != nil {
					return fmt.Errorf("failed to create SSH config: %w", err)
				}

				// Set up SSH to use the config file
				sshCmd = fmt.Sprintf("GIT_SSH_COMMAND='ssh -F %s -o StrictHostKeyChecking=no' git -C %s push -u origin %s", sshConfigPath, gitopsWorktree, workspaceName)
			} else {
				// Set up SSH to use the generated key for push operations
				sshKeyPath := filepath.Join(gitopsConfig, "ssh", "id_ed25519")
				sshCmd = fmt.Sprintf("GIT_SSH_COMMAND='ssh -i %s -o StrictHostKeyChecking=no' git -C %s push -u origin %s", sshKeyPath, gitopsWorktree, workspaceName)
			}

			setUpstreamCom := exec.Command("su", "-s", "/bin/sh", "user1000", "-c", sshCmd) //nolint:gosec
			if err := util.RunCommandVerbose(setUpstreamCom, *verbose); err != nil {
				return fmt.Errorf("failed to set upstream: %w", err)
			}
		}
	}

	fmt.Println("GitOps worktree set up successfully!")

	// Fix ownership of gitops worktree to user1000:1000 so the GitOps container can access it
	// The daemon runs as root, but the GitOps container runs as user1000
	// NOTE: We do NOT chown the workspace directory itself, as it may be used as a source
	// for cloning by other workspaces. The daemon (root) needs to be able to clone from it.
	// Only the gitops worktree needs to be owned by user1000 for the GitOps container.
	fmt.Println("Fixing ownership of gitops worktree...")
	chownGitopsCmd := exec.Command("chown", "-R", "1000:1000", gitopsWorktree)
	if err := util.RunCommandVerbose(chownGitopsCmd, *verbose); err != nil {
		return fmt.Errorf("failed to fix ownership of gitops directory: %w", err)
	}
	fmt.Println("Ownership fixed successfully!")

	// Set up the per-BP git-repos dir + the empty `main` copy. Every business
	// process gets its OWN bare repo (created by gitops at BP creation); the
	// `main` copy holds a checkout of each BP's main. The gitops worktree
	// above remains the promoted-deployment state repo.
	if err := setupBPRepoDirAndMainCopy(gitopsConfig, *verbose); err != nil {
		return fmt.Errorf("failed to set up git repos dir: %w", err)
	}

	// Create secrets directory
	secretsDir := gitopsConfig + "/secrets"
	if err := os.MkdirAll(secretsDir, 0700); err != nil {
		return fmt.Errorf("failed to create secrets directory: %w", err)
	}

	if oauthConfig != nil {
		oauthConfigFile := gitopsConfig + "/oauth-config.yaml"
		oauthConfigYaml, err := yaml.Marshal(oauthConfig)
		if err != nil {
			return fmt.Errorf("failed to marshal OAuth config: %w", err)
		}
		if err := os.WriteFile(oauthConfigFile, oauthConfigYaml, 0600); err != nil {
			return fmt.Errorf("failed to write oauth config file: %w", err)
		}
	}

	// Generate SSH key pair for the workspace (if not already generated for remote repo)
	if *remoteRepo == "" {
		fmt.Println("Generating SSH key pair for workspace...")
		sshKeyPair, err := ssh.GenerateSSHKeyPair(gitopsConfig)
		if err != nil {
			return fmt.Errorf("failed to generate SSH key pair: %w", err)
		}
		fmt.Printf("SSH key pair generated: %s\n", sshKeyPair.PublicKeyPath)
	}

	// Set hosts to /etc/hosts file
	if *setHosts {
		err := setHostsFile(workspaceName, *domain)
		if err != nil {
			fmt.Printf("\033[33m%s\033[0m\n", err)
		}
	}

	imgopsImage := *gitopsImage
	if imgopsImage == "" {
		var err error
		imgopsImage, err = dockerhub.ResolveGitopsImage(*staging)
		if err != nil {
			return fmt.Errorf("failed to get latest BitSwan GitOps image: %w", err)
		}
	}

	// Resolve service images lazily — only hit Docker Hub for services we'll
	// actually deploy. Otherwise `bitswan workspace init --no-dashboard`
	// fails if the dashboard image repo isn't reachable.
	var bitswanDashboardImage string
	if !*noDashboard {
		bitswanDashboardImage = *dashboardImage
		if bitswanDashboardImage == "" {
			var err error
			bitswanDashboardImage, err = dockerhub.ResolveDashboardImage(*staging)
			if err != nil {
				return fmt.Errorf("failed to get latest BitSwan workspace-dashboard image: %w", err)
			}
		}
	}

	var bitswanCodingAgentImage string
	if !*noCodingAgent {
		bitswanCodingAgentImage = *codingAgentImage
		if bitswanCodingAgentImage == "" {
			var err error
			bitswanCodingAgentImage, err = dockerhub.ResolveCodingAgentImage(*staging)
			if err != nil {
				return fmt.Errorf("failed to get latest BitSwan coding-agent image: %w", err)
			}
		}
	}

	// Generate the coding-agent secret up-front so it can be persisted to
	// metadata before the service starts. The coding-agent container is started
	// with this secret in env, and gitops re-discovers it via `docker inspect`.
	var codingAgentSecret string
	if !*noCodingAgent {
		codingAgentSecret = uuid.NewString()
	}

	fmt.Println("Setting up GitOps deployment...")
	gitopsDeployment := gitopsConfig + "/deployment"
	if err := os.MkdirAll(gitopsDeployment, 0755); err != nil {
		return fmt.Errorf("failed to create deployment directory: %w", err)
	}

	// The workspace dashboard endpoint is the workspace's membership
	// surface: the other workspace endpoints (gitops, editor, and later
	// every automation gitops deploys) register it as their ACL parent,
	// so workspace members can share what the workspace spawns.
	workspaceParent := ""
	if !*noDashboard {
		workspaceParent = fmt.Sprintf("%s-dashboard.%s", workspaceName, *domain)
	}

	// Register GitOps service route via the daemon's ingress abstraction.
	// addRouteToIngress detects the ingress type and handles certs + routing.
	gitopsHostname := fmt.Sprintf("%s-gitops.%s", workspaceName, *domain)
	gitopsUpstream := fmt.Sprintf("%s-gitops:8079", workspaceName)
	if err := addRouteToIngress(IngressAddRouteRequest{
		Hostname:       gitopsHostname,
		Upstream:       gitopsUpstream,
		Mkcert:         *mkCerts,
		CertsDir:       *certsDir,
		WorkspaceName:  workspaceName,
		OwnerEmail:     *owner,
		DisplayName:    workspaceName + " (gitops)",
		ParentEndpoint: workspaceParent,
	}, ""); err != nil {
		return fmt.Errorf("failed to register GitOps service: %w", err)
	}

	// Install wildcard TLS policies for the workspace domain (Caddy needs this
	// so all subdomains — gitops, editor, automations — are covered by the same cert).
	// Must be done AFTER per-hostname cert registration to avoid being overwritten.
	if (*mkCerts || *certsDir != "") && DetectIngressType() == IngressCaddy {
		if err := caddyapi.InstallTLSCerts(workspaceName, *domain); err != nil {
			return fmt.Errorf("failed to install TLS certificates: %w", err)
		}
	}

	var aocEnvVars []string
	workspaceId := ""
	fmt.Println("Registering workspace...")

	// Try to create AOC client
	aocClient, err := aoc.NewAOCClient()
	if err != nil {
		fmt.Println("Automation server config not found, skipping workspace registration.")
	} else {
		fmt.Println("Getting automation server token...")
		automationServerToken, err := aocClient.GetAutomationServerToken()
		if err != nil {
			fmt.Println("No automation server token available, skipping workspace registration.")
		} else {
			fmt.Println("Automation server token received successfully!")

			workspaceId, err = aocClient.RegisterWorkspace(workspaceName, *domain)
			if err != nil {
				return fmt.Errorf("failed to register workspace: %w", err)
			}
			fmt.Println("Workspace registered successfully!")

			// Automatically fetch OAuth configuration when AOC is configured
			if !*noOauth {
				fmt.Println("Fetching OAuth configuration from AOC...")
				oauthConfig, err = aocClient.GetOAuthConfig(workspaceId)
				if err != nil {
					return fmt.Errorf("failed to get OAuth config from AOC: %w", err)
				}
				fmt.Println("OAuth configuration fetched successfully!")

				// Save OAuth config to disk
				if err := oauth.SaveOauthConfig(workspaceName, oauthConfig); err != nil {
					return fmt.Errorf("failed to save OAuth config: %w", err)
				}
			} else {
				fmt.Println("OAuth disabled, using password authentication")
			}

			aocEnvVars = aocClient.GetAOCEnvironmentVariables(workspaceId, automationServerToken)
		}
	}

	var oauthEnvVars []string
	var keycloakURL string
	if oauthConfig != nil {
		oauthEnvVars = oauth.CreateOAuthEnvVars(oauthConfig, "gitops", workspaceName, *domain)
		keycloakURL = oauthConfig.IssuerUrl
	}

	// Log local remote info for debugging
	if localRemotePath != "" && localRemoteName != "" {
		fmt.Printf("Configuring local repository mount: %s -> /remote-repos/%s\n", localRemotePath, localRemoteName)
	}

	config := &dockercompose.DockerComposeConfig{
		GitopsPath:         gitopsConfig,
		WorkspaceName:      workspaceName,
		GitopsImage:        imgopsImage,
		Domain:             *domain,
		AocEnvVars:         aocEnvVars,
		OAuthEnvVars:       oauthEnvVars,
		GitopsDevSourceDir: *gitopsDevSourceDir,
		TrustCA:            true,
		LocalRemotePath:    localRemotePath,
		LocalRemoteName:    localRemoteName,
		KeycloakURL:        keycloakURL,
		CodingAgentSecret:  codingAgentSecret,
	}
	compose, token, err := config.CreateDockerComposeFile()

	if err != nil {
		return fmt.Errorf("failed to create docker-compose file: %w", err)
	}

	dockerComposePath := gitopsDeployment + "/docker-compose.yml"
	if err := os.WriteFile(dockerComposePath, []byte(compose), 0755); err != nil {
		return fmt.Errorf("failed to write docker-compose file: %w", err)
	}

	err = os.Chdir(gitopsDeployment)
	if err != nil {
		return fmt.Errorf("failed to change directory to GitOps deployment: %w", err)
	}

	fmt.Println("GitOps deployment set up successfully!")

	// Save metadata to file
	if err := saveMetadata(gitopsConfig, workspaceName, token, *domain, *noDashboard, *noCodingAgent, &workspaceId, *gitopsDevSourceDir, *dashboardDevSourceDir, *codingAgentDevSourceDir, codingAgentSecret); err != nil {
		fmt.Printf("Warning: Failed to save metadata: %v\n", err)
	}

	// Docker compose project names must be lowercase
	projectName := strings.ToLower(workspaceName) + "-site"
	// Use --pull missing to pull images if they don't exist locally (needed for CI)
	dockerComposeCom := exec.Command("docker", "compose", "-p", projectName, "up", "-d", "--pull", "missing")

	fmt.Println("Launching BitSwan Workspace services...")
	if err := util.RunCommandVerbose(dockerComposeCom, true); err != nil {
		return fmt.Errorf("failed to start docker-compose: %w", err)
	}

	fmt.Println("BitSwan GitOps initialized successfully!")

	// Sync updated workspace list to AOC
	if err := syncWorkspaceListToAOC(); err != nil {
		fmt.Printf("Warning: Failed to sync workspace list to AOC: %v\n", err)
	}

	// Setup dashboard service if not disabled.
	if !*noDashboard {
		fmt.Println("Setting up workspace-dashboard service...")

		dashboardService, err := services.NewDashboardService(workspaceName)
		if err != nil {
			return fmt.Errorf("failed to create dashboard service: %w", err)
		}

		if err := dashboardService.Enable(token, bitswanDashboardImage, true); err != nil {
			return fmt.Errorf("failed to enable dashboard service: %w", err)
		}

		dashboardHostname := fmt.Sprintf("%s-dashboard.%s", workspaceName, *domain)
		dashboardUpstream := fmt.Sprintf("%s-dashboard:8080", workspaceName)
		if err := addRouteToIngress(IngressAddRouteRequest{
			Hostname:      dashboardHostname,
			Upstream:      dashboardUpstream,
			Mkcert:        *mkCerts,
			CertsDir:      *certsDir,
			WorkspaceName: workspaceName,
			OwnerEmail:    *owner,
			DisplayName:   workspaceName + " (dashboard)",
		}, ""); err != nil {
			return fmt.Errorf("failed to register Dashboard service: %w", err)
		}

		if err := dashboardService.StartContainer(); err != nil {
			return fmt.Errorf("failed to start dashboard container: %w", err)
		}

		fmt.Println("------------WORKSPACE DASHBOARD INFO------------")
		fmt.Printf("Workspace Dashboard URL: https://%s-dashboard.%s\n", workspaceName, *domain)
	}

	// Setup coding-agent service if not disabled.
	if !*noCodingAgent {
		fmt.Println("Setting up coding-agent service...")

		codingAgentService, err := services.NewCodingAgentService(workspaceName)
		if err != nil {
			return fmt.Errorf("failed to create coding-agent service: %w", err)
		}

		var devConfig *services.CodingAgentDevConfig
		if *codingAgentDevSourceDir != "" {
			devConfig = &services.CodingAgentDevConfig{
				DevMode:   true,
				SourceDir: *codingAgentDevSourceDir,
			}
		}

		if err := codingAgentService.Enable(codingAgentSecret, bitswanCodingAgentImage, *domain, devConfig); err != nil {
			return fmt.Errorf("failed to enable coding-agent service: %w", err)
		}

		if err := codingAgentService.StartContainer(); err != nil {
			return fmt.Errorf("failed to start coding-agent container: %w", err)
		}

		fmt.Println("------------CODING AGENT INFO------------")
		fmt.Printf("Coding Agent container: %s-coding-agent\n", workspaceName)
	}

	fmt.Println("------------GITOPS INFO------------")
	fmt.Printf("GitOps ID: %s\n", workspaceName)
	fmt.Printf("GitOps URL: https://%s-gitops.%s\n", workspaceName, *domain)
	fmt.Printf("GitOps Secret: %s\n", token)

	if oauthConfig != nil {
		fmt.Printf("OAuth is enabled for the Editor.\n")
	}

	return nil
}

// resolveWorkspaceInitDomain decides the domain for a new workspace when the
// operator didn't pass --domain. --local already defaults to
// bs-<name>.localhost upstream, so this only fills an omitted, non-local
// domain from the server's configured domain — ProtectedHostnameDomain(),
// which is the AOC-assigned domain in the common case and honors the
// protected-domain override when set. An explicit --domain always wins; when
// no config (or no configured domain) is available it returns the input
// unchanged, preserving today's behavior.
func resolveWorkspaceInitDomain(domain string, local bool, cfg *config.Config) string {
	if domain != "" || local || cfg == nil {
		return domain
	}
	return cfg.ProtectedHostnameDomain()
}

// Helper functions moved from cmd/init.go

type RepositoryInfo struct {
	Hostname string
	Org      string
	Repo     string
	IsSSH    bool
}

func setHostsFile(workspaceName, domain string) error {
	fmt.Println("Checking if the user has permission to write to /etc/hosts...")
	fileInfo, err := os.Stat("/etc/hosts")
	if err != nil {
		return fmt.Errorf("error: %w", err)
	}

	if fileInfo.Mode().Perm()&0200 == 0 {
		return fmt.Errorf("user does not have permission to write to /etc/hosts")
	}
	fmt.Println("File /etc/hosts is writable")

	hostsEntries := []string{
		"127.0.0.1 " + workspaceName + "-gitops." + domain,
	}

	for _, entry := range hostsEntries {
		if exec.Command("grep", "-wq", entry, "/etc/hosts").Run() == nil {
			return fmt.Errorf("hosts already set in /etc/hosts")
		}
	}

	fmt.Println("Adding record to /etc/hosts...")
	for _, entry := range hostsEntries {
		cmdStr := "echo '" + entry + "' | sudo tee -a /etc/hosts"
		addHostsCom := exec.Command("sh", "-c", cmdStr)
		if err := util.RunCommandVerbose(addHostsCom, false); err != nil {
			return fmt.Errorf("unable to write into '/etc/hosts'. \n Please add the records manually")
		}
	}

	fmt.Println("Records added to /etc/hosts successfully!")
	return nil
}

func saveMetadata(gitopsConfig, workspaceName, token, domain string, noDashboard, noCodingAgent bool, workspaceId *string, gitopsDevSourceDir, dashboardDevSourceDir, codingAgentDevSourceDir, codingAgentSecret string) error {
	metadata := config.WorkspaceMetadata{
		Domain:       domain,
		GitopsURL:    fmt.Sprintf("https://%s-gitops.%s", workspaceName, domain),
		GitopsSecret: token,
	}

	if workspaceId != nil {
		metadata.WorkspaceId = workspaceId
	}

	if !noDashboard {
		dashboardURL := fmt.Sprintf("https://%s-dashboard.%s", workspaceName, domain)
		metadata.DashboardURL = &dashboardURL
	}

	if gitopsDevSourceDir != "" {
		metadata.GitopsDevSourceDir = &gitopsDevSourceDir
	}

	// Dev mode for the dashboard is implied by its source dir being set.
	// The DevMode bool is still written for backward-compat consumers but no
	// longer gates the per-service dev-mode behavior.
	if dashboardDevSourceDir != "" {
		metadata.DashboardDevSourceDir = &dashboardDevSourceDir
		metadata.DevMode = true
	}

	if !noCodingAgent {
		metadata.CodingAgentEnabled = true
		metadata.CodingAgentSecret = codingAgentSecret
	}

	if codingAgentDevSourceDir != "" {
		metadata.DevMode = true
	}

	metadataPath := filepath.Join(gitopsConfig, "metadata.yaml")
	if err := metadata.SaveToFile(metadataPath); err != nil {
		return fmt.Errorf("failed to save metadata: %w", err)
	}

	return nil
}

func parseRepositoryURL(repoURL string) (*RepositoryInfo, error) {
	repoURL = strings.TrimSpace(repoURL)
	if strings.HasPrefix(repoURL, "git://") {
		url := strings.TrimPrefix(repoURL, "git://")
		url = strings.TrimPrefix(url, "git@")

		parts := strings.SplitN(url, "/", 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf("invalid git:// URL format: %s", repoURL)
		}

		hostname := parts[0]
		path := parts[1]

		if len(path) > 0 && path[0] >= '0' && path[0] <= '9' {
			slashIndex := strings.Index(path, "/")
			if slashIndex == -1 {
				return nil, fmt.Errorf("invalid git:// URL format - port number without path: %s", repoURL)
			}
			path = path[slashIndex+1:]
		}

		path = strings.TrimSuffix(path, ".git")
		pathParts := strings.Split(path, "/")
		if len(pathParts) != 2 {
			return nil, fmt.Errorf("invalid repository path format: %s", path)
		}

		return &RepositoryInfo{
			Hostname: hostname,
			Org:      pathParts[0],
			Repo:     pathParts[1],
			IsSSH:    true,
		}, nil
	}

	if strings.HasPrefix(repoURL, "git@") {
		url := strings.TrimPrefix(repoURL, "git@")
		lastColonIndex := strings.LastIndex(url, ":")
		if lastColonIndex == -1 {
			return nil, fmt.Errorf("invalid SSH URL format: %s", repoURL)
		}

		hostname := url[:lastColonIndex]
		path := url[lastColonIndex+1:]

		if len(path) > 0 && path[0] >= '0' && path[0] <= '9' {
			slashIndex := strings.Index(path, "/")
			if slashIndex == -1 {
				return nil, fmt.Errorf("invalid SSH URL format - port number without path: %s", repoURL)
			}
			path = path[slashIndex+1:]
		}

		path = strings.TrimSuffix(path, ".git")
		pathParts := strings.Split(path, "/")
		if len(pathParts) != 2 {
			return nil, fmt.Errorf("invalid repository path format: %s", path)
		}

		return &RepositoryInfo{
			Hostname: hostname,
			Org:      pathParts[0],
			Repo:     pathParts[1],
			IsSSH:    true,
		}, nil
	}

	if strings.HasPrefix(repoURL, "https://") {
		url := strings.TrimPrefix(repoURL, "https://")
		url = strings.TrimSuffix(url, ".git")

		parts := strings.Split(url, "/")
		if len(parts) < 3 {
			return nil, fmt.Errorf("invalid HTTPS URL format: %s", repoURL)
		}

		hostname := parts[0]
		org := parts[1]
		repo := parts[2]

		return &RepositoryInfo{
			Hostname: hostname,
			Org:      org,
			Repo:     repo,
			IsSSH:    false,
		}, nil
	}

	if strings.Contains(repoURL, "/") && !strings.HasPrefix(repoURL, "git@") && !strings.HasPrefix(repoURL, "git://") && !strings.HasPrefix(repoURL, "https://") {
		slashIndex := strings.Index(repoURL, "/")
		if slashIndex > 0 {
			hostname := repoURL[:slashIndex]
			path := repoURL[slashIndex+1:]

			if colonIndex := strings.LastIndex(hostname, ":"); colonIndex > 0 {
				portPart := hostname[colonIndex+1:]
				isNumeric := true
				for _, c := range portPart {
					if c < '0' || c > '9' {
						isNumeric = false
						break
					}
				}
				if isNumeric {
					hostname = hostname[:colonIndex]
				}
			}

			path = strings.TrimSuffix(path, ".git")
			pathParts := strings.Split(path, "/")
			if len(pathParts) >= 2 {
				return &RepositoryInfo{
					Hostname: hostname,
					Org:      pathParts[0],
					Repo:     pathParts[1],
					IsSSH:    false,
				}, nil
			}
		}
	}

	return nil, fmt.Errorf("unsupported URL format: %s", repoURL)
}

func validatePort(portStr string) (int, error) {
	if portStr == "" {
		return 0, fmt.Errorf("port cannot be empty")
	}

	port, err := strconv.Atoi(portStr)
	if err != nil {
		return 0, fmt.Errorf("invalid port format '%s': %w", portStr, err)
	}

	if port < 1 || port > 65535 {
		return 0, fmt.Errorf("port %d is out of valid range (1-65535)", port)
	}

	return port, nil
}

func createSSHConfig(workspacePath, workspaceName string, repoInfo *RepositoryInfo, port string) (string, error) {
	portNum, err := validatePort(port)
	if err != nil {
		return "", fmt.Errorf("invalid port: %w", err)
	}

	sshDir := filepath.Join(workspacePath, "ssh")
	configPath := filepath.Join(sshDir, "config")

	var sshHostname string
	switch repoInfo.Hostname {
	case "github.com":
		sshHostname = "ssh.github.com"
	case "gitlab.com":
		sshHostname = "gitlab.com"
	default:
		sshHostname = repoInfo.Hostname
	}

	configContent := fmt.Sprintf(`Host git-%s
  HostName %s
  User git
  IdentityFile %s
  IdentitiesOnly yes
  Port %d
  AddKeysToAgent yes
`, workspaceName, sshHostname, filepath.Join(workspacePath, "ssh", "id_ed25519"), portNum)

	if err := os.WriteFile(configPath, []byte(configContent), 0600); err != nil {
		return "", fmt.Errorf("failed to write SSH config file: %w", err)
	}

	return configPath, nil
}

// setupBPRepoDirAndMainCopy creates the directory that holds the per-BP bare
// repos (git-repos/, one <bp>.git per business process, served fast-forward
// only over smart-HTTP) and the empty `main` copy directory. A fresh workspace
// has ZERO business processes, so no repos are created here — gitops creates
// each BP's repo when the BP is created, and materializes its
// copies/main/<bp> checkout when the BP first reaches main.
func setupBPRepoDirAndMainCopy(gitopsConfig string, verbose bool) error {
	reposDir := filepath.Join(gitopsConfig, "git-repos")
	copiesDir := filepath.Join(gitopsConfig, "copies")
	mainCopy := filepath.Join(copiesDir, "main")

	for _, d := range []string{reposDir, mainCopy} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return fmt.Errorf("create %s: %w", d, err)
		}
	}
	// gitops/editor containers run as user1000.
	for _, d := range []string{reposDir, copiesDir} {
		if err := exec.Command("chown", "-R", "1000:1000", d).Run(); err != nil {
			return fmt.Errorf("chown %s: %w", d, err)
		}
	}
	return nil
}

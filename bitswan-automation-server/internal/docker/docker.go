package docker

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// IsDockerAvailable checks if docker command is available in PATH
func IsDockerAvailable() bool {
	_, err := exec.LookPath("docker")
	return err == nil
}

// IsUbuntuLTS checks if the system is running Ubuntu LTS
// Supported LTS versions: 22.04 (Jammy), 24.04 (Noble)
func IsUbuntuLTS() (bool, string, error) {
	if runtime.GOOS != "linux" {
		return false, "", nil
	}

	// Read /etc/os-release
	osReleasePath := "/etc/os-release"
	data, err := os.ReadFile(osReleasePath)
	if err != nil {
		return false, "", fmt.Errorf("failed to read %s: %w", osReleasePath, err)
	}

	var id, versionID string
	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "ID=") {
			id = strings.Trim(strings.TrimPrefix(line, "ID="), "\"")
		}
		if strings.HasPrefix(line, "VERSION_ID=") {
			versionID = strings.Trim(strings.TrimPrefix(line, "VERSION_ID="), "\"")
		}
	}

	if id != "ubuntu" {
		return false, "", nil
	}

	// Check if it's an LTS version
	// Ubuntu 22.04 (Jammy) and 24.04 (Noble) are LTS
	ltsVersions := map[string]string{
		"22.04": "Jammy",
		"24.04": "Noble",
	}

	codename, isLTS := ltsVersions[versionID]
	return isLTS, codename, nil
}

type DockerNetwork struct {
	Name string `json:"Name"`
}

func checkNetworkExists(networkName string) (bool, error) {
	cmd := exec.Command("docker", "network", "ls", "--format=json")
	output, err := cmd.Output()
	if err != nil {
		return false, fmt.Errorf("error running docker command: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(string(output)), "\n")

	for _, line := range lines {
		var network DockerNetwork
		if err := json.Unmarshal([]byte(line), &network); err != nil {
			return false, fmt.Errorf("error parsing JSON: %v", err)
		}

		if network.Name == networkName {
			return true, nil
		}
	}

	return false, nil
}

// EnsureDockerNetwork ensures a Docker network exists, creating it if necessary.
// The network still comes out of Bailey's address range, but with no role to size
// or label it by; prefer EnsureDockerNetworkSpec, which records what it is for.
func EnsureDockerNetwork(name string, verbose bool) (bool, error) {
	return EnsureDockerNetworkSpec(NetworkSpec{Name: name}, verbose)
}

// createAttempts bounds the retry below. Two concurrent creates can pick the same
// free block; Docker rejects the loser, and re-reading the daemon's networks is
// enough to settle it. More than a couple of rounds means something other than a
// race is wrong.
const createAttempts = 4

// EnsureDockerNetworkSpec ensures a Docker network exists, creating it from
// Bailey's own address range (see subnets.go) and labelling it with what it is for.
func EnsureDockerNetworkSpec(spec NetworkSpec, verbose bool) (bool, error) {
	name := spec.Name
	exists, err := checkNetworkExists(name)
	if err != nil {
		return false, fmt.Errorf("error checking network %s: %w", name, err)
	}
	if exists {
		if verbose {
			fmt.Printf("Network called '%s' already exists...\n", name)
		}
		return true, nil
	}
	if verbose {
		fmt.Printf("Creating Docker network '%s'...\n", name)
	}

	var lastErr error
	var refused []*net.IPNet
	for attempt := 0; attempt < createAttempts; attempt++ {
		args := []string{"network", "create"}
		// A subnet we choose keeps this create off Docker's default address pools.
		// If we cannot choose one — no daemon to ask, a base that is full or
		// misconfigured — fall through to an unqualified create, which is what
		// Bailey always did: a network from the default pools beats no network,
		// and pool exhaustion still reports itself below.
		subnet, subnetErr := nextFreeSubnet(spec.Role, refused)
		if subnetErr == nil {
			args = append(args, "--subnet", subnet.String())
		} else if verbose {
			fmt.Printf("Falling back to Docker's own address pools for '%s': %v\n", name, subnetErr)
		}
		for _, label := range spec.Labels() {
			args = append(args, "--label", label)
		}
		args = append(args, name)

		cmd := exec.Command("docker", args...)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		if verbose {
			cmd.Stdout = os.Stdout
		}
		err := cmd.Run()
		if err == nil {
			if verbose {
				fmt.Printf("Docker network '%s' created!\n", name)
			}
			return true, nil
		}

		out := stderr.String()
		if verbose {
			fmt.Fprint(os.Stderr, out)
		}
		if strings.Contains(strings.ToLower(out), "already exists") {
			return true, nil
		}
		if AddressPoolsExhausted(out) {
			return false, NewAddressPoolsExhaustedError(fmt.Sprintf("create Docker network %q", name), out, err)
		}
		if subnetErr == nil && subnetOverlap(out) {
			// Someone took the block between our read and our create. Re-read,
			// and rule this one out so the next attempt cannot pick it again.
			refused = append(refused, subnet)
			lastErr = fmt.Errorf("create Docker network %q: %s", name, strings.TrimSpace(out))
			continue
		}
		if msg := strings.TrimSpace(out); msg != "" {
			return false, fmt.Errorf("create Docker network %q: %s", name, msg)
		}
		return false, fmt.Errorf("create Docker network %q: %w", name, err)
	}
	if lastErr == nil {
		// Unreachable while every `continue` above records why. Belt and braces:
		// a false with no error is the swallowed failure this package exists to
		// stop returning.
		lastErr = fmt.Errorf("create Docker network %q: gave up after %d attempts", name, createAttempts)
	}
	return false, lastErr
}

// subnetOverlap reports whether Docker turned a create down because the subnet we
// asked for is already spoken for.
func subnetOverlap(output string) bool {
	return strings.Contains(strings.ToLower(output), "overlaps")
}

// PromptUser prompts the user with a yes/no question
func PromptUser(question string) (bool, error) {
	fmt.Print(question + " [y/N]: ")
	reader := bufio.NewReader(os.Stdin)
	response, err := reader.ReadString('\n')
	if err != nil {
		return false, fmt.Errorf("failed to read user input: %w", err)
	}

	response = strings.TrimSpace(strings.ToLower(response))
	return response == "y" || response == "yes", nil
}

// InstallDocker installs Docker Engine on Ubuntu following the official guide
// https://docs.docker.com/engine/install/ubuntu/
// This function must be run with root privileges (or sudo)
func InstallDocker() error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("Docker installation requires root privileges. Please run with sudo")
	}

	fmt.Println("Installing Docker Engine on Ubuntu...")

	// Step 1: Uninstall old versions
	fmt.Println("Removing old Docker packages if any...")
	uninstallCmd := exec.Command("sh", "-c", "apt remove -y $(dpkg --get-selections docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc 2>/dev/null | cut -f1) 2>/dev/null || true")
	uninstallCmd.Stdout = os.Stdout
	uninstallCmd.Stderr = os.Stderr
	_ = uninstallCmd.Run() // Ignore errors, packages might not exist

	// Step 2: Set up Docker's apt repository
	fmt.Println("Setting up Docker's apt repository...")

	// Update package index
	updateCmd := exec.Command("apt", "update")
	updateCmd.Stdout = os.Stdout
	updateCmd.Stderr = os.Stderr
	if err := updateCmd.Run(); err != nil {
		return fmt.Errorf("failed to update package index: %w", err)
	}

	// Install prerequisites
	installPrereqCmd := exec.Command("apt", "install", "-y", "ca-certificates", "curl")
	installPrereqCmd.Stdout = os.Stdout
	installPrereqCmd.Stderr = os.Stderr
	if err := installPrereqCmd.Run(); err != nil {
		return fmt.Errorf("failed to install prerequisites: %w", err)
	}

	// Create keyrings directory
	keyringsDir := "/etc/apt/keyrings"
	mkdirCmd := exec.Command("install", "-m", "0755", "-d", keyringsDir)
	mkdirCmd.Stdout = os.Stdout
	mkdirCmd.Stderr = os.Stderr
	if err := mkdirCmd.Run(); err != nil {
		return fmt.Errorf("failed to create keyrings directory: %w", err)
	}

	// Download and install Docker's GPG key
	downloadKeyCmd := exec.Command("curl", "-fsSL", "https://download.docker.com/linux/ubuntu/gpg", "-o", keyringsDir+"/docker.asc")
	downloadKeyCmd.Stdout = os.Stdout
	downloadKeyCmd.Stderr = os.Stderr
	if err := downloadKeyCmd.Run(); err != nil {
		return fmt.Errorf("failed to download Docker GPG key: %w", err)
	}

	// Set permissions on GPG key
	chmodCmd := exec.Command("chmod", "a+r", keyringsDir+"/docker.asc")
	chmodCmd.Stdout = os.Stdout
	chmodCmd.Stderr = os.Stderr
	if err := chmodCmd.Run(); err != nil {
		return fmt.Errorf("failed to set GPG key permissions: %w", err)
	}

	// Get Ubuntu codename
	getCodenameCmd := exec.Command("sh", "-c", ". /etc/os-release && echo ${UBUNTU_CODENAME:-$VERSION_CODENAME}")
	codenameOutput, err := getCodenameCmd.Output()
	if err != nil {
		return fmt.Errorf("failed to get Ubuntu codename: %w", err)
	}
	codename := strings.TrimSpace(string(codenameOutput))

	// Add Docker repository
	repoContent := fmt.Sprintf("Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: %s\nComponents: stable\nSigned-By: %s/docker.asc\n", codename, keyringsDir)
	teeCmd := exec.Command("tee", "/etc/apt/sources.list.d/docker.sources")
	teeCmd.Stdin = strings.NewReader(repoContent)
	teeCmd.Stdout = os.Stdout
	teeCmd.Stderr = os.Stderr
	if err := teeCmd.Run(); err != nil {
		return fmt.Errorf("failed to add Docker repository: %w", err)
	}

	// Update package index again (create new command, cannot reuse after Run())
	updateCmd2 := exec.Command("apt", "update")
	updateCmd2.Stdout = os.Stdout
	updateCmd2.Stderr = os.Stderr
	if err := updateCmd2.Run(); err != nil {
		return fmt.Errorf("failed to update package index after adding repository: %w", err)
	}

	// Step 3: Install Docker packages
	fmt.Println("Installing Docker Engine...")
	installDockerCmd := exec.Command("apt", "install", "-y", "docker-ce", "docker-ce-cli", "containerd.io", "docker-buildx-plugin", "docker-compose-plugin")
	installDockerCmd.Stdout = os.Stdout
	installDockerCmd.Stderr = os.Stderr
	if err := installDockerCmd.Run(); err != nil {
		return fmt.Errorf("failed to install Docker packages: %w", err)
	}

	fmt.Println("Docker Engine has been successfully installed!")
	return nil
}

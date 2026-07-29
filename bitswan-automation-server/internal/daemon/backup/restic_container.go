package backup

// Running restic where restic does not exist.
//
// A machine being rebuilt after a disaster has the bitswan binary and docker,
// and nothing else. restic is not part of the binary — it ships inside the
// automation-server runtime image — so the daemon-less paths (reading a
// backup's manifest, restoring server state before any daemon exists) drive
// restic in a throwaway container from that image.
//
// The image should come from the manifest's daemon_image where one is known:
// it names the restic that WROTE the repo, which is what makes the repo format
// certain to be readable. On the very first read there is no manifest yet, so
// the default below is used to fetch one.

// DefaultRuntimeImage provides a restic when no manifest has been read yet.
const DefaultRuntimeImage = "bitswan/automation-server-runtime:latest"

// BitswanConfigVolume is the docker volume holding the server's own state
// (config, bailey.db, traefik, protected-proxy). Mounted at the path the
// snapshot recorded, so `restic restore --target /` reconstructs into it.
const BitswanConfigVolume = "bitswan"

// BitswanNetwork is the docker network on which a .localhost dev AOC resolves.
const BitswanNetwork = "bitswan_network"

// dockerBinary is a var so tests can point it at a fake.
var dockerBinary = "docker"

// ContainerExec runs restic inside a throwaway container instead of expecting
// it on the host.
type ContainerExec struct {
	Image   string   // runtime image providing a compatible restic
	Volumes []string // docker -v specs, e.g. "bitswan:/root/.config/bitswan"
	Network string   // docker network to join, when the AOC resolves only there
}

// NewContainerExec builds a runner for the given image, falling back to the
// default when the caller has no manifest to name one.
func NewContainerExec(image string) *ContainerExec {
	if image == "" {
		image = DefaultRuntimeImage
	}
	return &ContainerExec{Image: image}
}

// WithConfigVolume mounts the server config volume where the snapshot's
// absolute paths expect it, so a restore lands in the place the daemon will
// later read. Uses /root/.config/bitswan because that is $HOME/.config/bitswan
// inside the runtime image, which is the path the capture recorded.
func (c *ContainerExec) WithConfigVolume() *ContainerExec {
	c.Volumes = append(c.Volumes, BitswanConfigVolume+":/root/.config/bitswan")
	return c
}

// OnBitswanNetwork joins the docker network — needed only for a .localhost dev
// AOC, whose hostname resolves nowhere else.
func (c *ContainerExec) OnBitswanNetwork() *ContainerExec {
	c.Network = BitswanNetwork
	return c
}

// argv builds the `docker run` argv.
//
// Credential VALUES never appear here: `-e NAME` without `=` tells docker to
// take the value from its own environment, which the caller has already set.
// That keeps secrets out of the process table exactly as the host path does.
func (c *ContainerExec) argv(envNames []string, resticArgs []string) []string {
	argv := []string{"run", "--rm", "-i"}
	for _, name := range envNames {
		argv = append(argv, "-e", name)
	}
	if c.Network != "" {
		argv = append(argv, "--network", c.Network)
	}
	for _, volume := range c.Volumes {
		argv = append(argv, "-v", volume)
	}
	// The runtime image's default command is the daemon itself, so restic is
	// named explicitly — via --entrypoint rather than as a command argument, so
	// this keeps working if the image ever grows a real entrypoint.
	argv = append(argv, "--entrypoint", "restic", c.Image)
	return append(argv, resticArgs...)
}

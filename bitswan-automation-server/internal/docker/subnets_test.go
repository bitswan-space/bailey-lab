package docker

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func cidr(t *testing.T, s string) *net.IPNet {
	t.Helper()
	_, n, err := net.ParseCIDR(s)
	if err != nil {
		t.Fatalf("bad CIDR in test: %s: %v", s, err)
	}
	return n
}

func cidrs(t *testing.T, ss ...string) []*net.IPNet {
	t.Helper()
	out := make([]*net.IPNet, 0, len(ss))
	for _, s := range ss {
		out = append(out, cidr(t, s))
	}
	return out
}

// --- the allocator itself ---------------------------------------------------

func TestAllocateSubnet_StartsAtTheBottomOfTheBase(t *testing.T) {
	got, err := allocateSubnet(cidr(t, "10.128.0.0/12"), 24, nil)
	if err != nil {
		t.Fatalf("allocateSubnet: %v", err)
	}
	if got.String() != "10.128.0.0/24" {
		t.Errorf("first allocation = %s; want 10.128.0.0/24", got)
	}
}

func TestAllocateSubnet_StepsOverWhatIsTaken(t *testing.T) {
	taken := cidrs(t, "10.128.0.0/24", "10.128.1.0/24", "10.128.2.0/24")
	got, err := allocateSubnet(cidr(t, "10.128.0.0/12"), 24, taken)
	if err != nil {
		t.Fatalf("allocateSubnet: %v", err)
	}
	if got.String() != "10.128.3.0/24" {
		t.Errorf("allocated %s; want the next free block 10.128.3.0/24", got)
	}
}

// A partial overlap still counts: a /28 sitting inside a /24 rules that /24 out.
func TestAllocateSubnet_TreatsPartialOverlapAsTaken(t *testing.T) {
	got, err := allocateSubnet(cidr(t, "10.128.0.0/12"), 24, cidrs(t, "10.128.0.16/28"))
	if err != nil {
		t.Fatalf("allocateSubnet: %v", err)
	}
	if got.String() == "10.128.0.0/24" {
		t.Fatal("allocated a /24 that already has a /28 inside it")
	}
	if got.String() != "10.128.1.0/24" {
		t.Errorf("allocated %s; want 10.128.1.0/24", got)
	}
}

// The reason for the whole change: a stage network is a /24, not the /16 Docker
// would have taken, and each role gets a size that matches what it holds.
func TestNetworkPrefixLen_SizesByRole(t *testing.T) {
	for _, tc := range []struct {
		role NetworkRole
		want int
	}{
		{RoleStage, 24},
		{RoleAgent, 28},
		{RolePlatform, 20},
		{RoleInfra, 28},
		{NetworkRole(""), 24},
	} {
		if got := networkPrefixLen(tc.role); got != tc.want {
			t.Errorf("networkPrefixLen(%q) = /%d; want /%d", tc.role, got, tc.want)
		}
	}
	if networkPrefixLen(RoleStage) <= 16 {
		t.Error("a stage network must be smaller than the /16 a bare docker create takes")
	}
}

func TestAllocateSubnet_ReturnsAlignedBlocks(t *testing.T) {
	// A /28 first, so the following /24 cannot start at 10.128.0.0.
	taken := cidrs(t, "10.128.0.0/28")
	got, err := allocateSubnet(cidr(t, "10.128.0.0/12"), 24, taken)
	if err != nil {
		t.Fatalf("allocateSubnet: %v", err)
	}
	ones, _ := got.Mask.Size()
	if ones != 24 {
		t.Fatalf("allocated /%d; want /24", ones)
	}
	if !got.IP.Equal(got.IP.Mask(got.Mask)) {
		t.Errorf("%s is not aligned to its own mask", got)
	}
}

func TestAllocateSubnet_ReportsAFullBase(t *testing.T) {
	// A /24 base holds exactly one /24, and it is taken.
	_, err := allocateSubnet(cidr(t, "10.128.0.0/24"), 24, cidrs(t, "10.128.0.0/24"))
	if err == nil {
		t.Fatal("allocated out of a base with nothing left in it")
	}
	if !strings.Contains(err.Error(), "10.128.0.0/24") {
		t.Errorf("error should name the base it ran out of, got: %v", err)
	}
}

func TestAllocateSubnet_RejectsABlockBiggerThanTheBase(t *testing.T) {
	if _, err := allocateSubnet(cidr(t, "10.128.0.0/24"), 20, nil); err == nil {
		t.Fatal("allocated a /20 inside a /24")
	}
}

// A single route covering the whole base must not turn into a scan of every
// candidate block inside it.
func TestAllocateSubnet_SkipsPastALargeBlocker(t *testing.T) {
	base := cidr(t, "10.0.0.0/8")
	got, err := allocateSubnet(base, 28, cidrs(t, "10.0.0.0/9"))
	if err != nil {
		t.Fatalf("allocateSubnet: %v", err)
	}
	if got.String() != "10.128.0.0/28" {
		t.Errorf("allocated %s; want the first block past the blocker, 10.128.0.0/28", got)
	}
}

// --- host routes ------------------------------------------------------------

func TestAllocateWithin_PrefersSpaceTheHostDoesNotRoute(t *testing.T) {
	base := cidr(t, "10.128.0.0/12")
	routes := cidrs(t, "10.128.0.0/16") // a VPN leg overlapping the bottom of the base
	got, err := allocateWithin(base, 24, nil, routes)
	if err != nil {
		t.Fatalf("allocateWithin: %v", err)
	}
	if firstOverlap(got, routes) != nil {
		t.Errorf("allocated %s, which collides with a host route", got)
	}
}

// The case that must not become a hard failure: an ordinary VPC routes 10.0.0.0/8,
// which covers the entire default base. Refusing to allocate would leave Bailey
// unable to create any network at all, so it allocates anyway and warns.
func TestAllocateWithin_StillAllocatesWhenRoutesCoverEverything(t *testing.T) {
	base := cidr(t, "10.128.0.0/12")
	got, err := allocateWithin(base, 24, nil, cidrs(t, "10.0.0.0/8"))
	if err != nil {
		t.Fatalf("routes covering the base must not stop allocation: %v", err)
	}
	if !base.Contains(got.IP) {
		t.Errorf("allocated %s, outside the base %s", got, base)
	}
}

// Docker's own networks are not advisory: a block that collides with one cannot
// be created, so it is never handed out even when routes leave nothing else.
func TestAllocateWithin_NeverReusesAnExistingDockerSubnet(t *testing.T) {
	base := cidr(t, "10.128.0.0/22")
	existing := cidrs(t, "10.128.0.0/24", "10.128.1.0/24")
	got, err := allocateWithin(base, 24, existing, cidrs(t, "10.0.0.0/8"))
	if err != nil {
		t.Fatalf("allocateWithin: %v", err)
	}
	if firstOverlap(got, existing) != nil {
		t.Errorf("allocated %s, which an existing Docker network already holds", got)
	}
}

// --- the base ---------------------------------------------------------------

func TestSubnetBase_DefaultsClearOfTheAOCProvisionedPool(t *testing.T) {
	t.Setenv(SubnetBaseEnv, "")
	base, err := SubnetBase()
	if err != nil {
		t.Fatalf("SubnetBase: %v", err)
	}
	// automation-operation-center#356 writes { "base": "10.0.0.0/12" } into
	// default-address-pools on servers the AOC provisions. Both mechanisms are
	// live on such a server and must not hand out the same addresses.
	aocPool := cidr(t, "10.0.0.0/12")
	if firstOverlap(base, []*net.IPNet{aocPool}) != nil {
		t.Errorf("default base %s overlaps the pool the AOC provisions (%s)", base, aocPool)
	}
}

func TestSubnetBase_HonoursTheOperatorOverride(t *testing.T) {
	t.Setenv(SubnetBaseEnv, "192.168.128.0/17")
	base, err := SubnetBase()
	if err != nil {
		t.Fatalf("SubnetBase: %v", err)
	}
	if base.String() != "192.168.128.0/17" {
		t.Errorf("base = %s; want the override 192.168.128.0/17", base)
	}
}

func TestSubnetBase_RejectsNonsense(t *testing.T) {
	for _, bad := range []string{"not-a-cidr", "10.128.0.0", "fd00::/8"} {
		t.Setenv(SubnetBaseEnv, bad)
		if _, err := SubnetBase(); err == nil {
			t.Errorf("accepted %s=%q", SubnetBaseEnv, bad)
		}
	}
}

// --- labels -----------------------------------------------------------------

func TestNetworkSpec_LabelsRecordWhatTheNetworkIsFor(t *testing.T) {
	got := NetworkSpec{Name: "ws-dev", Role: RoleStage, Workspace: "ws", Stage: "dev"}.Labels()
	want := []string{"bitswan.managed=true", "bitswan.role=stage", "bitswan.workspace=ws", "bitswan.stage=dev"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("labels = %v; want %v", got, want)
	}
}

func TestNetworkSpec_LabelsOmitWhatIsNotKnown(t *testing.T) {
	got := strings.Join(NetworkSpec{Name: "bitswan_network"}.Labels(), ",")
	if got != "bitswan.managed=true" {
		t.Errorf("labels = %q; want just the managed marker", got)
	}
}

// --- end to end, against a stub docker --------------------------------------

// stubDocker installs a `docker` that answers the three subcommands allocation
// needs and records the create it is asked to run. Driving the real code path
// rather than a mock of it, in the style of address_pools_test.go.
func stubDocker(t *testing.T) (argvFile string) {
	t.Helper()
	dir := t.TempDir()
	argvFile = filepath.Join(dir, "create-argv")
	script := `
case "$1 $2" in
  "network ls")
    if [ "$3" = "-q" ]; then printf '%s\n' $STUB_IDS; else printf '%s\n' "$STUB_LS_JSON"; fi ;;
  "network inspect") printf '%s\n' $STUB_SUBNETS ;;
  "network create")
    echo "$@" >> "$STUB_ARGV"
    if [ -n "$STUB_CREATE_ERR" ] && [ ! -f "$STUB_ARGV.retried" ]; then
      if [ -n "$STUB_CREATE_ONCE" ]; then touch "$STUB_ARGV.retried"; fi
      echo "$STUB_CREATE_ERR" >&2
      exit 1
    fi
    exit 0 ;;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "docker"), []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatal(err)
	}
	// A silent `ip` too: allocation consults the host's routes, and without this
	// the expected subnet would depend on what the machine running the tests
	// happens to route.
	if err := os.WriteFile(filepath.Join(dir, "ip"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("STUB_ARGV", argvFile)
	t.Setenv("STUB_LS_JSON", `{"Name":"bridge"}`)
	t.Setenv("STUB_IDS", "")
	t.Setenv("STUB_SUBNETS", "")
	t.Setenv("STUB_CREATE_ERR", "")
	t.Setenv("STUB_CREATE_ONCE", "")
	t.Setenv(SubnetBaseEnv, "10.128.0.0/12")
	return argvFile
}

func createArgv(t *testing.T, argvFile string) []string {
	t.Helper()
	data, err := os.ReadFile(argvFile)
	if err != nil {
		t.Fatalf("no create was run: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	return strings.Fields(lines[len(lines)-1])
}

func argValue(argv []string, flag string) string {
	for i, a := range argv {
		if a == flag && i+1 < len(argv) {
			return argv[i+1]
		}
	}
	return ""
}

// The claim the whole change rests on: Docker only draws from its default address
// pools when a create arrives without a subnet, so every create must carry one.
func TestEnsureDockerNetworkSpec_CreatesWithAnExplicitSubnet(t *testing.T) {
	argvFile := stubDocker(t)

	ok, err := EnsureDockerNetworkSpec(NetworkSpec{Name: "ws-dev", Role: RoleStage, Workspace: "ws", Stage: "dev"}, false)
	if !ok || err != nil {
		t.Fatalf("EnsureDockerNetworkSpec = %v, %v; want true, nil", ok, err)
	}

	subnet := argValue(createArgv(t, argvFile), "--subnet")
	if subnet == "" {
		t.Fatal("created the network without --subnet; Docker would take a /16 from its default pools")
	}
	if subnet != "10.128.0.0/24" {
		t.Errorf("--subnet %s; want 10.128.0.0/24", subnet)
	}
}

func TestEnsureDockerNetworkSpec_LabelsWhatItCreates(t *testing.T) {
	argvFile := stubDocker(t)

	if _, err := EnsureDockerNetworkSpec(NetworkSpec{
		Name: "ws-dev", Role: RoleStage, Workspace: "ws", Stage: "dev",
	}, false); err != nil {
		t.Fatalf("EnsureDockerNetworkSpec: %v", err)
	}

	argv := strings.Join(createArgv(t, argvFile), " ")
	for _, want := range []string{
		"--label bitswan.managed=true",
		"--label bitswan.role=stage",
		"--label bitswan.workspace=ws",
		"--label bitswan.stage=dev",
	} {
		if !strings.Contains(argv, want) {
			t.Errorf("create is missing %q\ngot: %s", want, argv)
		}
	}
}

func TestEnsureDockerNetworkSpec_AvoidsSubnetsDockerAlreadyHandedOut(t *testing.T) {
	argvFile := stubDocker(t)
	t.Setenv("STUB_IDS", "aaa bbb")
	t.Setenv("STUB_SUBNETS", "10.128.0.0/24 10.128.1.0/24")

	if _, err := EnsureDockerNetworkSpec(NetworkSpec{Name: "ws-dev", Role: RoleStage}, false); err != nil {
		t.Fatalf("EnsureDockerNetworkSpec: %v", err)
	}

	if got := argValue(createArgv(t, argvFile), "--subnet"); got != "10.128.2.0/24" {
		t.Errorf("--subnet %s; want the first block clear of the existing two, 10.128.2.0/24", got)
	}
}

// Two concurrent creates can choose the same free block. Docker rejects the
// loser; re-reading the daemon's networks is enough to settle it.
func TestEnsureDockerNetworkSpec_RetriesWhenSomeoneTookTheBlockFirst(t *testing.T) {
	argvFile := stubDocker(t)
	t.Setenv("STUB_CREATE_ERR", "Error response from daemon: Pool overlaps with other one on this address space")
	t.Setenv("STUB_CREATE_ONCE", "1")

	ok, err := EnsureDockerNetworkSpec(NetworkSpec{Name: "ws-dev", Role: RoleStage}, false)
	if !ok || err != nil {
		t.Fatalf("EnsureDockerNetworkSpec = %v, %v; want the retry to succeed", ok, err)
	}

	data, err := os.ReadFile(argvFile)
	if err != nil {
		t.Fatal(err)
	}
	if n := len(strings.Split(strings.TrimSpace(string(data)), "\n")); n != 2 {
		t.Errorf("ran %d creates; want 2 (the rejected one and the retry)", n)
	}
}

func TestEnsureDockerNetworkSpec_GivesUpOnAPersistentOverlap(t *testing.T) {
	stubDocker(t)
	t.Setenv("STUB_CREATE_ERR", "Error response from daemon: Pool overlaps with other one on this address space")

	if _, err := EnsureDockerNetworkSpec(NetworkSpec{Name: "ws-dev", Role: RoleStage}, false); err == nil {
		t.Fatal("retried forever instead of reporting an overlap that will not clear")
	}
}

// A base we cannot use must not stop Bailey creating networks: fall back to the
// unqualified create, which is what it always did, and let #440's error speak if
// the pools are also gone.
func TestEnsureDockerNetworkSpec_FallsBackWhenTheBaseIsUnusable(t *testing.T) {
	argvFile := stubDocker(t)
	t.Setenv(SubnetBaseEnv, "not-a-cidr")

	ok, err := EnsureDockerNetworkSpec(NetworkSpec{Name: "ws-dev", Role: RoleStage}, false)
	if !ok || err != nil {
		t.Fatalf("EnsureDockerNetworkSpec = %v, %v; want the create to go ahead anyway", ok, err)
	}

	argv := createArgv(t, argvFile)
	if got := argValue(argv, "--subnet"); got != "" {
		t.Errorf("passed --subnet %s from an unusable base", got)
	}
	if !strings.Contains(strings.Join(argv, " "), "bitswan.managed=true") {
		t.Error("the fallback create should still label the network")
	}
}

func TestEnsureDockerNetworkSpec_StillReportsExhaustionOnTheFallbackPath(t *testing.T) {
	stubDocker(t)
	t.Setenv(SubnetBaseEnv, "not-a-cidr")
	t.Setenv("STUB_CREATE_ERR", exhaustedStderr)

	_, err := EnsureDockerNetworkSpec(NetworkSpec{Name: "ws-dev", Role: RoleStage}, false)
	if !IsAddressPoolsExhausted(err) {
		t.Fatalf("err = %v; want it still recognisable as pool exhaustion", err)
	}
}

// Sizing is what turns ~31 networks into thousands. Guard the arithmetic.
func TestBaseHoldsFarMoreNetworksThanDockersDefaults(t *testing.T) {
	base := cidr(t, DefaultSubnetBase)
	ones, _ := base.Mask.Size()
	stages := 1 << uint(networkPrefixLen(RoleStage)-ones)
	if stages < 1000 {
		t.Fatalf("%s holds only %d stage networks; Docker's own defaults hold about 31", DefaultSubnetBase, stages)
	}
	// Four networks per workspace: -dev, -staging, -production, -agent.
	if workspaces := stages / 4; workspaces < 250 {
		t.Errorf("only %d workspaces fit; the whole point is to stop running out", workspaces)
	}
}

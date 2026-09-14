package docker

import (
	"bytes"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
)

// Bailey allocates the networks it creates out of a range it owns, passing an
// explicit --subnet, instead of letting Docker pick.
//
// Docker only draws from default-address-pools when a create arrives WITHOUT a
// subnet, so this keeps Bailey off those pools entirely: no /etc/docker/daemon.json
// to edit and no `systemctl restart docker` (which restarts every container on the
// box) on a server we did not provision, and the pools stay free for whatever else
// runs on the host.
//
// It also buys the right size. A bare create takes a whole /16 out of 172.16.0.0/12
// — 65534 addresses for a network holding one workspace's automations for one stage.
// Thirty-two of those is the entire default supply, which is why a stock daemon is
// dry at about seven workspaces. Sizing per role instead (see networkPrefixLen) puts
// 1024 stage-sized networks in the default base — 338 workspaces, measured by running
// the allocator — and a daemon-wide default-address-pools `size` cannot do that: it is
// one size for every network on the host.
//
// Networks that already exist are never touched — Docker keeps their addresses in
// its local store, nothing renumbers, and the old /16s come back as workspaces are
// removed.

// DefaultSubnetBase is the range Bailey allocates from unless BITSWAN_NETWORK_BASE
// says otherwise.
//
// Deliberately clear of 10.0.0.0/12, which the AOC writes into default-address-pools
// when it provisions a server (automation-operation-center#356): on such a server both
// mechanisms are live and must not hand out the same addresses.
const DefaultSubnetBase = "10.128.0.0/12"

// SubnetBaseEnv overrides DefaultSubnetBase. Operators whose VPC or VPN already
// routes 10.128.0.0/12 point Bailey somewhere else with this.
const SubnetBaseEnv = "BITSWAN_NETWORK_BASE"

// NetworkRole says what a network is for. It picks the block size and is recorded
// as a label, so an operator (and a future capacity report) can tell Bailey's
// networks apart from everything else on the host.
type NetworkRole string

const (
	// RoleStage is a per-(workspace, stage) automation network: <ws>-dev and friends.
	RoleStage NetworkRole = "stage"
	// RoleAgent is a per-workspace coding-agent↔gitops bridge: <ws>-agent.
	RoleAgent NetworkRole = "agent"
	// RolePlatform is the shared control-plane network: bitswan_network.
	RolePlatform NetworkRole = "platform"
	// RoleInfra is a supporting singleton such as the build proxy.
	RoleInfra NetworkRole = "infra"
)

// networkPrefixLen is the block size per role. Generous against what each network
// actually holds, and still four thousand networks to a /12.
func networkPrefixLen(role NetworkRole) int {
	switch role {
	case RolePlatform:
		return 20 // every workspace's gitops, the ingress and the proxies: 4094 addresses
	case RoleAgent:
		return 28 // the agent and gitops, nothing else: 14
	case RoleInfra:
		// The build proxies are two containers, but every concurrent image build
		// joins this network too (build.go passes it to `docker build --network`),
		// and workspace applies run concurrently. A /28 would cap the server at
		// about twelve builds at once.
		return 24
	default:
		// A stage network is the one whose occupancy is not bounded by the
		// workspace's own size. Its dev realm also carries every live-dev copy —
		// BITSWAN_MAX_LIVE_DEV instances (default 15), each costing an egress
		// gateway, its proxy, and a frontend that keeps its own netns under a
		// monitor gateway — and that cap is an operator knob. A /24 fills at
		// about 80 instances; a /22 is 1022 addresses and still leaves the base
		// room for ~340 workspaces.
		return 22
	}
}

// NetworkSpec describes a network to create: what to call it, how big it needs to
// be, and what to label it with.
type NetworkSpec struct {
	Name string
	Role NetworkRole
	// Workspace and Stage are recorded as labels when set. Stage is meaningful
	// only for RoleStage.
	Workspace string
	Stage     string
}

// Labels are attached to every network Bailey creates. bitswan.managed is the one
// that matters most: without it Bailey's networks are indistinguishable from
// anything else on the host, which makes both capacity accounting and safe
// garbage collection impossible.
func (s NetworkSpec) Labels() []string {
	labels := []string{"bitswan.managed=true"}
	if s.Role != "" {
		labels = append(labels, "bitswan.role="+string(s.Role))
	}
	if s.Workspace != "" {
		labels = append(labels, "bitswan.workspace="+s.Workspace)
	}
	if s.Stage != "" {
		labels = append(labels, "bitswan.stage="+s.Stage)
	}
	return labels
}

// SubnetBase returns the range to allocate from.
func SubnetBase() (*net.IPNet, error) {
	raw := strings.TrimSpace(os.Getenv(SubnetBaseEnv))
	if raw == "" {
		raw = DefaultSubnetBase
	}
	_, base, err := net.ParseCIDR(raw)
	if err != nil {
		return nil, fmt.Errorf("%s=%q is not a CIDR range: %w", SubnetBaseEnv, raw, err)
	}
	if base.IP.To4() == nil {
		return nil, fmt.Errorf("%s=%q is not IPv4", SubnetBaseEnv, raw)
	}
	return base, nil
}

// allocateSubnet returns the lowest aligned block of prefixLen bits inside base
// that overlaps nothing in taken. Pure — every caller's view of "taken" is built
// elsewhere, which is what makes the placement logic testable without a daemon.
func allocateSubnet(base *net.IPNet, prefixLen int, taken []*net.IPNet) (*net.IPNet, error) {
	baseOnes, _ := base.Mask.Size()
	if prefixLen < baseOnes {
		return nil, fmt.Errorf("a /%d does not fit inside %s", prefixLen, base)
	}
	if prefixLen > 30 {
		return nil, fmt.Errorf("/%d is too small to be a usable network", prefixLen)
	}

	step := uint64(1) << uint(32-prefixLen)
	first := uint64(ipToU32(base.IP))
	last := first + (uint64(1) << uint(32-baseOnes)) - 1 // last address in base

	mask := net.CIDRMask(prefixLen, 32)
	for start := first; start+step-1 <= last; {
		candidate := &net.IPNet{IP: u32ToIP(uint32(start)), Mask: mask}
		clash := firstOverlap(candidate, taken)
		if clash == nil {
			return candidate, nil
		}
		// Skip the whole blocking range rather than stepping through it: a host
		// route for 10.0.0.0/8 would otherwise be 65536 candidate checks.
		clashOnes, _ := clash.Mask.Size()
		clashEnd := uint64(ipToU32(clash.IP)) + (uint64(1) << uint(32-clashOnes)) - 1
		next := ((clashEnd / step) + 1) * step
		if next <= start {
			break // no forward progress possible; bail rather than spin
		}
		start = next
	}
	return nil, fmt.Errorf("no free /%d left in %s", prefixLen, base)
}

// firstOverlap returns the first range in taken that intersects n, or nil.
func firstOverlap(n *net.IPNet, taken []*net.IPNet) *net.IPNet {
	for _, t := range taken {
		if t == nil {
			continue
		}
		if n.Contains(t.IP) || t.Contains(n.IP) {
			return t
		}
	}
	return nil
}

func ipToU32(ip net.IP) uint32 {
	v4 := ip.To4()
	if v4 == nil {
		return 0
	}
	return uint32(v4[0])<<24 | uint32(v4[1])<<16 | uint32(v4[2])<<8 | uint32(v4[3])
}

func u32ToIP(v uint32) net.IP {
	return net.IPv4(byte(v>>24), byte(v>>16), byte(v>>8), byte(v))
}

// existingSubnets lists every subnet Docker has already handed out, whether Bailey
// created the network or not. Read from the daemon on every allocation rather than
// from a ledger of our own: it cannot drift, and it picks up a network removed by
// hand without anything to reconcile.
func existingSubnets() []*net.IPNet {
	ids, err := exec.Command("docker", "network", "ls", "-q").Output()
	if err != nil {
		return nil
	}
	fields := strings.Fields(string(ids))
	if len(fields) == 0 {
		return nil
	}
	args := append([]string{"network", "inspect", "--format", "{{range .IPAM.Config}}{{.Subnet}}\n{{end}}"}, fields...)
	cmd := exec.Command("docker", args...)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	// Keep whatever it managed to print. `docker network inspect` exits non-zero
	// when any single id fails, and treating that as "nothing is taken" would be
	// the one mistake that hands out an address someone already has.
	_ = cmd.Run()
	return parseCIDRs(strings.Fields(stdout.String()))
}

// hostRoutes returns the IPv4 routes on this host, so allocation can steer around
// a VPN or VPC range: a subnet that collides with one of those leaves its
// containers with no route out, which is expensive to diagnose and cheap to avoid.
//
// Best-effort by design. Route collisions are steered around when we can see them
// (allocateWithin falls back if that leaves nothing free), while the collisions
// that actually break a create — other Docker networks — come from the daemon
// itself and are never guesswork.
func hostRoutes() []*net.IPNet {
	out, err := exec.Command("ip", "-4", "route", "show").Output()
	if err != nil {
		return nil
	}
	var dests []string
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		dest := fields[0]
		// A default route covers everything; treating it as taken would rule out
		// every base there is.
		if dest == "default" || dest == "0.0.0.0/0" {
			continue
		}
		if !strings.Contains(dest, "/") {
			dest += "/32"
		}
		dests = append(dests, dest)
	}
	return parseCIDRs(dests)
}

func parseCIDRs(raw []string) []*net.IPNet {
	var out []*net.IPNet
	for _, r := range raw {
		_, n, err := net.ParseCIDR(strings.TrimSpace(r))
		if err != nil || n.IP.To4() == nil {
			continue
		}
		out = append(out, n)
	}
	return out
}

// allocateWithin places a block of prefixLen bits, preferring one that clears the
// host's routes and settling for one that only clears Docker's own networks if it
// must.
//
// The fallback is the point: a host that routes 10.0.0.0/8 (an ordinary VPC) covers
// the whole default base, and refusing to allocate there would leave Bailey unable
// to create any network at all. Overlapping a route degrades one network's outbound
// routing; refusing degrades everything.
func allocateWithin(base *net.IPNet, prefixLen int, docker, routes []*net.IPNet) (*net.IPNet, error) {
	if subnet, err := allocateSubnet(base, prefixLen, append(append([]*net.IPNet{}, docker...), routes...)); err == nil {
		return subnet, nil
	}
	subnet, err := allocateSubnet(base, prefixLen, docker)
	if err != nil {
		return nil, err
	}
	if len(routes) > 0 && firstOverlap(subnet, routes) != nil {
		fmt.Fprintf(os.Stderr, "Warning: %s is the only space left in %s and it overlaps a route on this host; "+
			"set %s to a range this server does not already route.\n", subnet, base, SubnetBaseEnv)
	}
	return subnet, nil
}

// nextFreeSubnet picks the address range for a network about to be created.
// Blocks in avoid are ranges a create has already been turned down for, so a
// retry moves on instead of asking for the same one again — which matters when
// the daemon cannot be enumerated and the allocator is otherwise flying blind.
func nextFreeSubnet(role NetworkRole, avoid []*net.IPNet) (*net.IPNet, error) {
	base, err := SubnetBase()
	if err != nil {
		return nil, err
	}
	taken := append(existingSubnets(), avoid...)
	return allocateWithin(base, networkPrefixLen(role), taken, hostRoutes())
}

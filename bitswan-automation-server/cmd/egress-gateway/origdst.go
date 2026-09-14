package main

import (
	"encoding/binary"
	"net"
	"syscall"
	"unsafe"
)

// Linux netfilter getsockopt names. SO_ORIGINAL_DST (SOL_IP) and
// IP6T_SO_ORIGINAL_DST (SOL_IPV6) both have the value 80; they return the
// destination the peer ORIGINALLY dialed, before the nat table rewrote it. The
// proxy container's own PREROUTING REDIRECT (entrypoint.sh) funnels every TCP
// port the worker routes through us onto one listener, so this is how the
// catch-all learns which ip:port the worker was actually trying to reach.
const soOriginalDst = 80

// originalDst returns the pre-NAT destination of an accepted connection. ok is
// false when the kernel has no conntrack entry for it (a connection that was
// never NATed — e.g. something dialing the listener directly — or a platform
// without netfilter), in which case the caller must treat it as unroutable.
func originalDst(c net.Conn) (ip net.IP, port int, ok bool) {
	tc, isTCP := c.(*net.TCPConn)
	if !isTCP {
		return nil, 0, false
	}
	raw, err := tc.SyscallConn()
	if err != nil {
		return nil, 0, false
	}
	raw.Control(func(fd uintptr) {
		// IPv4 first — a dual-stack (AF_INET6) listener still answers the SOL_IP
		// query for a v4 peer, as the v4-mapped conntrack entry is a v4 one.
		var sa4 syscall.RawSockaddrInet4
		l := uint32(unsafe.Sizeof(sa4))
		if _, _, e := syscall.Syscall6(syscall.SYS_GETSOCKOPT, fd, syscall.IPPROTO_IP, soOriginalDst,
			uintptr(unsafe.Pointer(&sa4)), uintptr(unsafe.Pointer(&l)), 0); e == 0 && sa4.Family == syscall.AF_INET {
			ip = net.IPv4(sa4.Addr[0], sa4.Addr[1], sa4.Addr[2], sa4.Addr[3]).To4()
			port = int(binary.BigEndian.Uint16((*[2]byte)(unsafe.Pointer(&sa4.Port))[:]))
			ok = true
			return
		}
		var sa6 syscall.RawSockaddrInet6
		l = uint32(unsafe.Sizeof(sa6))
		if _, _, e := syscall.Syscall6(syscall.SYS_GETSOCKOPT, fd, syscall.IPPROTO_IPV6, soOriginalDst,
			uintptr(unsafe.Pointer(&sa6)), uintptr(unsafe.Pointer(&l)), 0); e == 0 && sa6.Family == syscall.AF_INET6 {
			ip = make(net.IP, net.IPv6len)
			copy(ip, sa6.Addr[:])
			port = int(binary.BigEndian.Uint16((*[2]byte)(unsafe.Pointer(&sa6.Port))[:]))
			ok = true
		}
	})
	return ip, port, ok
}

// localIP is the address our end of the connection is bound to — after a
// REDIRECT that is the proxy container's own interface address.
func localIP(c net.Conn) net.IP {
	if a, ok := c.LocalAddr().(*net.TCPAddr); ok {
		return a.IP
	}
	return nil
}

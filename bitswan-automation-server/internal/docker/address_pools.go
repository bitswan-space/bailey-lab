package docker

import (
	"errors"
	"fmt"
	"strings"
)

const AddressPoolRemedy = `Docker carves every network it creates out of its default address pools, and this
server has used them all up. Docker ships with room for about 31 networks; a
Bailey server needs several per workspace, so a busy server runs out.

Give Docker a larger pool. Create /etc/docker/daemon.json (or add this key to it):

    {
      "default-address-pools": [
        { "base": "10.0.0.0/12", "size": 27 }
      ]
    }

then restart Docker:

    systemctl restart docker

Pick a base range that does not overlap the private network this server sits on
— 10.0.0.0/12 is a good default, but not if your VPC or VPN already uses it.
Networks that already exist keep the addresses they were given; the new pool
applies to the next network Docker creates.`

type AddressPoolsExhaustedError struct {
	Action string
	Output string
	Err    error
}

func (e *AddressPoolsExhaustedError) Error() string {
	return fmt.Sprintf("%s: Docker has no address space left for a new network.\n\n%s", e.Action, AddressPoolRemedy)
}

func (e *AddressPoolsExhaustedError) Unwrap() error { return e.Err }

func AddressPoolsExhausted(output string) bool {
	return strings.Contains(strings.ToLower(output), "predefined address pools")
}

func IsAddressPoolsExhausted(err error) bool {
	var target *AddressPoolsExhaustedError
	return errors.As(err, &target)
}

func NewAddressPoolsExhaustedError(action, output string, err error) error {
	return &AddressPoolsExhaustedError{Action: action, Output: strings.TrimSpace(output), Err: err}
}

package daemon

import "flag"

// parseFlagsInterspersed parses args with fs, allowing flags to appear before
// AND after positional arguments (GNU-style). The CLI forwards its raw argv to
// the daemon, and Go's std flag package stops parsing at the first non-flag
// token — so a flag placed after the workspace name (e.g.
// `workspace init zztest --dev`) would be silently ignored. Re-parses the
// remainder after each positional so flag order relative to positionals
// doesn't matter. Returns the positional arguments in order.
func parseFlagsInterspersed(fs *flag.FlagSet, args []string) ([]string, error) {
	var positionals []string
	rest := args
	for len(rest) > 0 {
		if err := fs.Parse(rest); err != nil {
			return nil, err
		}
		rest = fs.Args()
		if len(rest) == 0 {
			break
		}
		positionals = append(positionals, rest[0])
		rest = rest[1:]
	}
	return positionals, nil
}

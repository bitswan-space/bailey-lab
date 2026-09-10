# e2e AOC stub

The walkthrough runs against a disposable Keycloak with no Automation
Operations Centre behind it, and almost nothing here wants one. The exception
is the login topology: re-pointing sign-in at the broker means provisioning the
protected proxy, and provisioning asks the AOC for the shared
`bitswan-protected` OAuth client. With nothing answering, the broker can only
come up with the customer's connector, so the Single sign-on chapter cannot
test the switch at all.

This serves that call — `POST /api/automation_server/keycloak/oauth-client` —
with the `bailey` client already seeded in `keycloak/realm-export.json`, plus
workspace registration, which the daemon starts doing once it believes it has
an AOC. Everything else 404s.

`bringup.sh` only starts the container. The daemon is registered against it by
the Single sign-on chapter itself, right before it needs one, because
registering changes behaviour well beyond sign-in: workers deployed afterwards
are stamped `BITSWAN_AUTH_MODE=aoc` and start verifying Bearer tokens. Every
other chapter should keep running against the AOC-less stack it always has.

The stub does not register redirect URIs in Keycloak the way a real AOC would,
so any callback the daemon derives must already be listed on the `bailey`
client in the realm export — including the broker's `https://auth.<domain>/callback`.

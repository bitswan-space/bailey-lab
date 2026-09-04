# e2e AOC stub

The walkthrough runs against a disposable Keycloak with no Automation
Operations Centre behind it. Almost nothing needs one — but the shared
protected proxy does: `provisionProtectedProxy` asks the AOC for the
`bitswan-protected` OAuth client's credentials, and the login-topology
reconcile behind the Single sign-on settings goes through the same call.
Without an answer the daemon can never (re)provision the proxy, so the
topology switch cannot be tested at all.

This serves exactly one endpoint —
`POST /api/automation_server/keycloak/oauth-client` — returning the `bailey`
client already seeded in `keycloak/realm-export.json`. Every other AOC call
404s, which is the same "there is no AOC" the walkthrough has always run with.

The stub does not register redirect URIs in Keycloak the way a real AOC would,
so any callback the daemon derives must already be listed on the `bailey`
client in the realm export.

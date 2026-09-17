package cmd

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
)

// browserStatePath is where the session is written. It is the same file the
// seeded .mcp.json passes to the Playwright MCP server as --storage-state, so a
// session established here is picked up by the browser tools with no further
// wiring. /home/agent is a persistent volume, so it survives a restart.
const browserStatePath = "/home/agent/.bitswan-browser-state.json"

type agentBrowserIdentity struct {
	Label     string   `json:"label"`
	Email     string   `json:"email"`
	Groups    []string `json:"groups"`
	CreatedAt string   `json:"created_at"`
}

type agentBrowserSession struct {
	CookieName   string   `json:"cookie_name"`
	CookieValue  string   `json:"cookie_value"`
	CookieDomain string   `json:"cookie_domain"`
	URL          string   `json:"url"`
	AppURL       string   `json:"app_url"`
	Email        string   `json:"email"`
	Groups       []string `json:"groups"`
	ExpiresAt     string   `json:"expires_at"`
	DeploymentID  string   `json:"deployment_id"`
	RequiredGroup string   `json:"required_group"`
}

var browserCmd = &cobra.Command{
	Use:   "browser",
	Short: "Open a live-dev deployment in a real browser, signed in as a test user",
	Long: `Drive a real browser at this copy's live-dev apps, signed in as a test
user you invent — so you can see what a person sees instead of guessing.

QUICK START

    bitswan-coding-agent browser identities create --label reviewer \
        --groups "/Example Org"
    bitswan-coding-agent deployments list                     # find the id
    bitswan-coding-agent browser session --as reviewer \
        --deployment frontend-copy-alice-invoices-live-dev

  Navigate to the URL that prints. It signs the browser in and redirects to the
  app. Screenshots land in .playwright-mcp/ in this directory.

TWO THINGS THAT LOOK LIKE BUGS AND ARE NOT

  1. Requests going to a "--inner" hostname. That is the platform, not a
     misconfigured app: the address you opened serves a frame around the app,
     and the app itself is served on the inner one. Both are signed in, and a
     failure there is a failure in the app.

  2. A screenshot that stops at the fold. The tools shoot the viewport unless
     you make it taller first — browser_resize, then take the shot.

  A 401 from the app's own API is a real finding. Report it.

WHY THERE IS A SIGN-IN AT ALL

  Apps here sit behind the platform's access gate. Reaching one without a
  session shows you the logged-out variant, which is not what a user sees, so a
  test that passes against it proves nothing about the deployed app.

  A session is for ONE live-dev deployment. Live-dev is this copy's own
  sandbox; staging and production are deliberately out of reach, and asking for
  a session on one is refused.

  Use the sign-in URL even if the browser is already open. A browser reads its
  saved cookies once, when it starts, so a session made just now is invisible to
  one that was already running — it would land on the sign-in page and look
  broken. The URL is what signs a running browser in, and it keeps working for
  the life of the session, so navigate to it again any time you are bounced to
  a login.

TEST USERS

  A test user exists only in this server's own identity provider for agents. It
  is not an account in the company directory, it grants nothing anywhere else,
  and its groups are whatever you say they are — which is the point, because an
  app decides what to show from the groups in the token.

    bitswan-coding-agent browser identities create --label boss \
        --groups "/Example Org,/Example Org/admin"

  Open the app as each and compare: that is how you tell an authorization bug
  from a rendering one.

  The deployment is woken first if it was asleep, so you are never diagnosing
  the platform's loading page.

FOR A SCRIPT INSTEAD OF THE MCP TOOLS

    const { chromium } = require('playwright')
    const browser = await chromium.launch({ channel: 'chromium',
                                            args: ['--no-sandbox'] })
    const ctx = await browser.newContext({
      storageState: process.env.BITSWAN_BROWSER_STATE,
    })
    const page = await ctx.newPage()
    page.on('console', m => console.log('console:', m.type(), m.text()))
    await page.goto(process.argv[2], { waitUntil: 'networkidle' })

  A script may write its screenshot anywhere; the MCP tools may only write
  inside this business process, so give them a relative path.

NEVER ROUTE AROUND THE GATE

  Not by container name, not by an internal address, not by a Host header aimed
  at one. Those paths skip the sign-in, so what you see is not what a user sees
  and proves nothing about the deployed app.`,
}

var (
	browserLabel      string
	browserEmail      string
	browserGroups     string
	browserDeployment string
	browserAs         string
)

var browserIdentitiesCmd = &cobra.Command{
	Use:   "identities",
	Short: "Manage the test users you can browse as",
}

var browserIdentitiesListCmd = &cobra.Command{
	Use:   "list",
	Short: "List this workspace's test users and the groups each carries",
	RunE: func(cmd *cobra.Command, args []string) error {
		var out struct {
			Identities []agentBrowserIdentity `json:"identities"`
		}
		if err := agentRequestJSON("GET", "/browser/identities", nil, &out); err != nil {
			return err
		}
		if len(out.Identities) == 0 {
			fmt.Println("No test users yet. Create one with:")
			fmt.Println("  bitswan-coding-agent browser identities create --label reviewer --groups \"/Example Org\"")
			return nil
		}
		w := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
		fmt.Fprintln(w, "LABEL\tEMAIL\tGROUPS")
		for _, id := range out.Identities {
			fmt.Fprintf(w, "%s\t%s\t%s\n", id.Label, id.Email, strings.Join(id.Groups, " "))
		}
		return w.Flush()
	},
}

var browserIdentitiesCreateCmd = &cobra.Command{
	Use:   "create",
	Short: "Create (or redefine) a test user with a chosen set of groups",
	RunE: func(cmd *cobra.Command, args []string) error {
		if strings.TrimSpace(browserLabel) == "" {
			return fmt.Errorf("--label is required: it is how you refer to this test user")
		}
		groups := []string{}
		for _, g := range strings.Split(browserGroups, ",") {
			if g = strings.TrimSpace(g); g != "" {
				groups = append(groups, g)
			}
		}
		body := map[string]any{"label": browserLabel, "groups": groups}
		if browserEmail != "" {
			body["email"] = browserEmail
		}
		var out struct {
			Identity agentBrowserIdentity `json:"identity"`
		}
		if err := agentRequestJSON("POST", "/browser/identities", body, &out); err != nil {
			return err
		}
		fmt.Printf("%s is %s", out.Identity.Label, out.Identity.Email)
		if len(out.Identity.Groups) > 0 {
			fmt.Printf(" in %s", strings.Join(out.Identity.Groups, ", "))
		} else {
			fmt.Print(" in no groups")
		}
		fmt.Println()
		return nil
	},
}

var browserIdentitiesDeleteCmd = &cobra.Command{
	Use:   "delete LABEL",
	Short: "Delete a test user and every session issued for it",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		path := "/browser/identities/" + url.PathEscape(args[0])
		if err := agentRequestJSON("DELETE", path, nil, nil); err != nil {
			return err
		}
		fmt.Printf("%s is gone, and so is any browser session that used it\n", args[0])
		return nil
	},
}

var browserSessionCmd = &cobra.Command{
	Use:   "session",
	Short: "Sign the browser in to one live-dev deployment as a test user",
	RunE: func(cmd *cobra.Command, args []string) error {
		if strings.TrimSpace(browserAs) == "" {
			return fmt.Errorf("--as is required: which test user to browse as (see `browser identities list`)")
		}
		if strings.TrimSpace(browserDeployment) == "" {
			return fmt.Errorf("--deployment is required (see `bitswan-coding-agent deployments list`)")
		}
		copyName, err := detectCopyOrFlag(copyFlag)
		if err != nil {
			return fmt.Errorf("cannot detect copy: %w", err)
		}
		var out agentBrowserSession
		path := "/browser/session?copy=" + url.QueryEscape(copyName)
		body := map[string]any{"label": browserAs, "deployment_id": browserDeployment}
		if err := agentRequestJSON("POST", path, body, &out); err != nil {
			return err
		}
		if err := writeBrowserState(out); err != nil {
			return err
		}
		fmt.Printf("Signed in as %s", out.Email)
		if len(out.Groups) > 0 {
			fmt.Printf(" (%s)", strings.Join(out.Groups, ", "))
		}
		fmt.Println()
		fmt.Println()
		fmt.Println("Open this URL FIRST — it signs the browser in and then lands on the app:")
		fmt.Printf("  %s\n", out.URL)
		fmt.Println()
		fmt.Println("Use it even if your browser is already open. A browser reads its saved")
		fmt.Println("cookies once, when it starts, so a session made just now is invisible to")
		fmt.Println("one that was already running — visiting this URL is what signs it in.")
		if out.AppURL != "" {
			fmt.Printf("Afterwards the app is at %s\n", out.AppURL)
		}
		if out.ExpiresAt != "" {
			fmt.Printf("The session lasts until %s; run this again if the app asks you to sign in.\n", out.ExpiresAt)
		}
		// An app that checks a group answers 403 to a test user carrying the
		// wrong one, which reads like a bug in the app rather than a detail of
		// how the identity was made up.
		if g := out.RequiredGroup; g != "" && !hasGroup(out.Groups, g) {
			fmt.Println()
			fmt.Printf("NOTE: this app only serves members of %q, and %s is not one.\n", g, out.Email)
			fmt.Println("Its API will answer 403 until you browse as a user that is:")
			fmt.Printf("  bitswan-coding-agent browser identities create --label member --groups %q\n", g)
		}
		return nil
	},
}

// writeBrowserState saves the session in Playwright's storage-state shape, at
// the path the seeded .mcp.json hands the browser as --storage-state.
//
// Written whole and replaced, never appended to: a session is for one
// deployment, so keeping an older one alongside it would silently leave the
// browser carrying two identities and make which one answered depend on the
// order the cookies came back in.
func writeBrowserState(s agentBrowserSession) error {
	if s.CookieName == "" || s.CookieValue == "" {
		return fmt.Errorf("the server returned no session cookie")
	}
	expires := float64(time.Now().Add(12 * time.Hour).Unix())
	if s.ExpiresAt != "" {
		if t, err := time.Parse(time.RFC3339, s.ExpiresAt); err == nil {
			expires = float64(t.Unix())
		}
	}
	state := map[string]any{
		"cookies": []any{map[string]any{
			"name":     s.CookieName,
			"value":    s.CookieValue,
			"domain":   s.CookieDomain,
			"path":     "/",
			"expires":  expires,
			"httpOnly": true,
			"secure":   true,
			"sameSite": "Lax",
		}},
		"origins": []any{},
	}
	blob, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	path := os.Getenv("BITSWAN_BROWSER_STATE")
	if path == "" {
		path = browserStatePath
	}
	// 0600: the cookie is what signs the browser in.
	if err := os.WriteFile(path, append(blob, '\n'), 0o600); err != nil {
		return fmt.Errorf("could not save the browser session to %s: %w", path, err)
	}
	return nil
}

func init() {
	browserIdentitiesCreateCmd.Flags().StringVar(&browserLabel, "label", "", "short name for the test user (e.g. reviewer)")
	browserIdentitiesCreateCmd.Flags().StringVar(&browserEmail, "email", "", "address it presents; defaults to one under a reserved test domain")
	browserIdentitiesCreateCmd.Flags().StringVar(&browserGroups, "groups", "", "comma-separated groups the token carries (e.g. \"/Example Org,/Example Org/admin\")")

	browserSessionCmd.Flags().StringVar(&browserAs, "as", "", "which test user to browse as")
	browserSessionCmd.Flags().StringVar(&browserDeployment, "deployment", "", "the live-dev deployment id to open")
	browserSessionCmd.Flags().StringVar(&copyFlag, "copy", copyFlag, "copy name (auto-detected from the working directory)")

	browserIdentitiesCmd.AddCommand(browserIdentitiesListCmd)
	browserIdentitiesCmd.AddCommand(browserIdentitiesCreateCmd)
	browserIdentitiesCmd.AddCommand(browserIdentitiesDeleteCmd)
	browserCmd.AddCommand(browserIdentitiesCmd)
	browserCmd.AddCommand(browserSessionCmd)
	rootCmd.AddCommand(browserCmd)
}

func hasGroup(groups []string, want string) bool {
	for _, g := range groups {
		if g == want {
			return true
		}
	}
	return false
}

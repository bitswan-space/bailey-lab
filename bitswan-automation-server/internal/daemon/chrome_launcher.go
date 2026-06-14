package daemon

import (
	"fmt"
	"html"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
)

// The Bailey launcher — a Start-menu-style button pinned to the left of the
// chrome footer. Clicking the BitSwan mark opens a popup that jumps the top
// window (out of the per-app iframe) to: the AOC, the Bailey Server Console,
// each workspace the user can reach, and — grouped under their workspace —
// each frontend the user can reach. Everything is filtered by the same ACL
// the gate enforces, so the menu only lists endpoints the user could open.

// bitswanMarkSVG is just the swan mark from the full logo (no wordmark),
// sized for the footer button and drawn in currentColor so CSS themes it.
const bitswanMarkSVG = `<svg width="15" height="15" viewBox="0 0 135 155" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M0,104.5V5l59.9,50L10.3,92.8C6,96,2.5,100,0,104.5z M90.7,80.6l-21.3,18c-7.1,6.2-10.9,14.5-10.9,24c0,8.6,3.4,16.7,9.4,22.8c6.1,6.1,14.2,9.5,22.8,9.5s16.7-3.4,22.8-9.5c6.1-6.1,9.4-14.2,9.4-22.8s-3.3-16.7-9.4-22.7L90.7,80.6z M118.5,15.8l-25,19.5l0,0L13.1,96.6C4.9,102.6,0,112.3,0,122.5c0,8.6,3.4,16.7,9.4,22.8c6.1,6.1,14.2,9.5,22.8,9.5h40.4c-2.9-1.6-5.6-3.7-8.1-6.1c-7-7-10.8-16.3-10.8-26.1c0-10.7,4.4-20.5,12.5-27.6l46-38.7c6.8-5.8,10.8-14.9,10.8-24C123,26.4,121.5,20.8,118.5,15.8z M57.5,0l36.1,29.3L115.7,12c-0.5-0.6-1.3-1.5-2.3-2.7C107,1.6,97.5,0,90.8,0H57.5z"/></svg>`

type launcherFrontend struct {
	Name string
	URL  string
}

type launcherWorkspace struct {
	Name string
	// URL is the workspace dashboard link, set only when the user can reach
	// the dashboard itself. A frontend the user can open whose workspace they
	// can't reach still shows under an (unlinked) group header.
	URL       string
	Frontends []launcherFrontend
}

type launcherData struct {
	AOCUrl       string
	DashboardURL string
	Workspaces   []launcherWorkspace
}

// baileyLauncherData assembles the launcher menu for one user. AOC + Server
// Console come from server config; workspaces/frontends come from the ACL,
// classified by the explicit endpoints.kind (never inferred from hostnames).
func baileyLauncherData(email string, groups []string) launcherData {
	var d launcherData
	if cfg, err := config.NewAutomationServerConfig().LoadConfig(); err == nil && cfg != nil {
		d.AOCUrl = cfg.AutomationOperationsCenter.AOCUrl
		if dom := cfg.ProtectedHostnameDomain(); dom != "" {
			// The Server Console is served by the daemon on the reserved
			// bailey.<domain> host (see serveServerConsole).
			d.DashboardURL = "https://" + serverConsoleHost(dom) + "/"
		}
	}

	eps, err := listAccessibleEndpoints(email, groups)
	if err != nil {
		return d
	}

	byHost := map[string]*launcherWorkspace{}
	var order []string
	ensureGroup := func(host string) *launcherWorkspace {
		k := strings.ToLower(host)
		if g, ok := byHost[k]; ok {
			return g
		}
		name := host
		if ep, _ := getEndpoint(host); ep != nil && ep.DisplayName != "" {
			name = ep.DisplayName
		}
		g := &launcherWorkspace{Name: name}
		byHost[k] = g
		order = append(order, k)
		return g
	}

	for _, e := range eps {
		if e.Kind == endpointKindWorkspace {
			g := ensureGroup(e.Hostname)
			if e.DisplayName != "" {
				g.Name = e.DisplayName
			}
			g.URL = "https://" + e.Hostname
		}
	}
	for _, e := range eps {
		// Only production frontends belong in the launcher — dev/staging/
		// live-dev are working copies, surfaced in the workspace dashboard.
		if e.Kind == endpointKindFrontend && e.ParentEndpoint != "" && e.Stage == "production" {
			g := ensureGroup(e.ParentEndpoint)
			name := e.DisplayName
			if name == "" {
				name = e.Hostname
			}
			g.Frontends = append(g.Frontends, launcherFrontend{Name: name, URL: "https://" + e.Hostname})
		}
	}
	for _, k := range order {
		g := byHost[k]
		// Skip empty groups that have neither a reachable dashboard nor any
		// reachable frontend (shouldn't happen, but keep the menu tidy).
		if g.URL == "" && len(g.Frontends) == 0 {
			continue
		}
		d.Workspaces = append(d.Workspaces, *g)
	}
	return d
}

// launcherCSS styles the Start-menu button and its popup, themed to the
// chrome footer's dark palette. Interpolated as a value (single %).
const launcherCSS = `
  footer.bailey-footer .bailey-launch {
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 20px; margin-right: 2px; flex-shrink: 0;
    border: 1px solid transparent; border-radius: 6px;
    background: transparent; color: #FAFAFA; cursor: pointer; padding: 0;
  }
  footer.bailey-footer .bailey-launch:hover,
  footer.bailey-footer .bailey-launch[aria-expanded="true"] { background: #27272A; }
  footer.bailey-footer .bailey-launch svg { display: block; }
  .bailey-menu {
    position: fixed; left: 8px; bottom: 34px; z-index: 2147483647;
    min-width: 248px; max-width: 340px; max-height: 70vh; overflow: auto;
    background: #09090B; color: #FAFAFA;
    border: 1px solid #27272A; border-radius: 10px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.5);
    padding: 6px; font: 13px/1.2 Roboto, system-ui, -apple-system, sans-serif;
    animation: bailey-menu-in 120ms ease-out;
  }
  @keyframes bailey-menu-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  .bailey-menu[hidden] { display: none; }
  .bailey-menu a.item {
    display: flex; align-items: center; gap: 9px; height: 34px; padding: 0 10px;
    border-radius: 7px; color: #FAFAFA; text-decoration: none; white-space: nowrap;
  }
  .bailey-menu a.item:hover { background: #27272A; }
  .bailey-menu a.item .ico { width: 16px; height: 16px; flex-shrink: 0; color: #A1A1AA; display: inline-flex; }
  .bailey-menu a.item .lbl { overflow: hidden; text-overflow: ellipsis; }
  .bailey-menu .sep { height: 1px; background: #27272A; margin: 6px 4px; }
  .bailey-menu .group-label {
    display: flex; align-items: center; gap: 7px; padding: 8px 10px 4px;
    font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #71717A;
  }
  .bailey-menu .group-label a { color: #A1A1AA; text-decoration: none; }
  .bailey-menu .group-label a:hover { color: #FAFAFA; text-decoration: underline; }
  .bailey-menu a.sub { padding-left: 30px; height: 30px; color: #D4D4D8; }
  .bailey-menu .empty { padding: 6px 10px; color: #52525B; font-size: 12px; }
`

// lucide-style inline icons for the menu rows (no external assets).
const (
	launchIconAOC       = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/></svg>`
	launchIconDashboard = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>`
	launchIconWorkspace = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`
	launchIconFrontend  = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/></svg>`
)

// baileyLauncherButtonHTML is the footer button (static — the BitSwan mark).
// It lives inside the footer; the menu must live outside it because the footer
// clips overflow.
func baileyLauncherButtonHTML() string {
	return `<button type="button" class="bailey-launch" id="bailey-launch-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="bailey-menu" title="Bailey launcher">` + bitswanMarkSVG + `</button>`
}

// baileyLauncherMenuHTML renders the popup panel (placed after the footer).
func baileyLauncherMenuHTML(d launcherData) string {
	var menu strings.Builder
	menu.WriteString(`<div id="bailey-menu" class="bailey-menu" hidden role="menu" aria-label="Bailey launcher">`)

	if d.AOCUrl != "" {
		menu.WriteString(launcherItem(launchIconAOC, "Automation Operations Center", d.AOCUrl, "item"))
	}
	if d.DashboardURL != "" {
		menu.WriteString(launcherItem(launchIconDashboard, "Bailey dashboard", d.DashboardURL, "item"))
	}

	if len(d.Workspaces) > 0 {
		menu.WriteString(`<div class="sep"></div>`)
		for _, ws := range d.Workspaces {
			// Group header: workspace name, linked to its dashboard when reachable.
			menu.WriteString(`<div class="group-label">` + launchIconWorkspace + `<span>`)
			if ws.URL != "" {
				menu.WriteString(`<a href="` + html.EscapeString(ws.URL) + `" target="_top">` + html.EscapeString(ws.Name) + `</a>`)
			} else {
				menu.WriteString(html.EscapeString(ws.Name))
			}
			menu.WriteString(`</span></div>`)
			if len(ws.Frontends) == 0 {
				menu.WriteString(`<div class="empty">No frontends you can open</div>`)
			}
			for _, fe := range ws.Frontends {
				menu.WriteString(launcherItem(launchIconFrontend, fe.Name, fe.URL, "item sub"))
			}
		}
	}

	menu.WriteString(`</div>`)
	return menu.String()
}

// serverConsoleHost returns the reserved hostname the daemon serves the Bailey
// Server Console on, for a given protected domain (e.g. bailey.acme.bswn.io).
func serverConsoleHost(domain string) string {
	return "bailey." + strings.TrimPrefix(domain, ".")
}

func launcherItem(icon, label, url, cls string) string {
	return fmt.Sprintf(`<a class="%s" href="%s" target="_top" role="menuitem"><span class="ico">%s</span><span class="lbl">%s</span></a>`,
		cls, html.EscapeString(url), icon, html.EscapeString(label))
}

// launcherJS toggles the popup and closes it on outside-click / Escape.
const launcherJS = `
(function(){
  var btn = document.getElementById('bailey-launch-btn');
  var menu = document.getElementById('bailey-menu');
  if (!btn || !menu) return;
  function open(){ menu.hidden = false; btn.setAttribute('aria-expanded','true'); }
  function close(){ menu.hidden = true; btn.setAttribute('aria-expanded','false'); }
  btn.addEventListener('click', function(e){ e.stopPropagation(); if (menu.hidden) open(); else close(); });
  document.addEventListener('click', function(e){ if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) close(); });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') close(); });
})();
`

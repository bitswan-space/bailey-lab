package daemon

import (
	"fmt"
	"html"
	"strings"
)

// mfa_scene.go renders the server-side gate pages (claim / trust-this-device
// / recover) so they match the wireframe auth-scenes (BootstrapScene,
// ApprovalScene, RecoveryScene) in
// bitswan-server-console/wireframe/server/auth-scenes.jsx.
//
// The look is a centered card on a subtle dot-grid surface, Inter as the
// UI font and Geist Mono for codes — the same SceneShell chrome the
// wireframe uses (the Bailey hexagon mark + host line, a white rounded
// card with a soft shadow, an optional footer note, and a status-tinted
// pill badge). All CSS is inlined because these pages run under a strict
// CSP that forbids external stylesheets.

// sceneColors mirror the wireframe tokens (styles/tokens.css):
//
//	fg          zinc-900   #18181b
//	muted       zinc-500   #71717a
//	mutedFg     zinc-400   #a1a1aa
//	border      zinc-200   #e4e4e7
//	surface     zinc-50    #fafafa
//	surface2    zinc-100   #f4f4f5
//	primary     #093df5    (Bitswan blue 600 — same as bitswanPageCSS)
//	primarySoft #e0e7ff
//	red         #dc2626
const (
	scFg          = "#18181b"
	scMuted       = "#71717a"
	scMutedFg     = "#a1a1aa"
	scBorder      = "#e4e4e7"
	scSurface     = "#fafafa"
	scSurface2    = "#f4f4f5"
	scPrimary     = "#093df5"
	scPrimarySoft = "#e0e7ff"
	scRed         = "#dc2626"
)

// scenePillTone styles the SceneShell badge pill (warning / danger).
type scenePillTone struct{ bg, fg string }

var (
	scPillWarning = scenePillTone{bg: "#fef3c7", fg: "#92400e"} // amber-soft
	scPillDanger  = scenePillTone{bg: "#fee2e2", fg: "#b91c1c"} // red-soft
)

// sceneBaseCSS is the shared inline stylesheet for the scene pages. It
// paints the dot-grid surface and styles the centered card chrome and the
// common controls (segmented-look inputs, primary/secondary buttons,
// method tabs) to match the wireframe SceneShell.
//
// NOTE on fonts: the wireframe loads Inter + Geist Mono from the open
// internet, but these pages run under the strict inner CSP (see
// strictInnerCSP), whose font-src/style-src only allow 'self' + the
// server's own domain — an external @import would be blocked. We keep
// 'Inter'/'Geist Mono' first in each stack (so a self-hosted copy is used
// if present) and fall back to the system UI / monospace stack, which is
// visually very close. No external asset references — CSP-clean.
const sceneBaseCSS = `
*{box-sizing:border-box;}
html,body{margin:0;padding:0;height:100%;}
body{font-family:'Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:#18181b;background:#fafafa;-webkit-font-smoothing:antialiased;}
.sc-wrap{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;overflow:auto;}
.sc-grid{position:fixed;inset:0;opacity:.5;background-image:radial-gradient(#e4e4e7 1px,transparent 1px);background-size:22px 22px;pointer-events:none;}
.sc-col{position:relative;width:440px;max-width:100%;}
.sc-brand{display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:18px;}
.sc-mark{width:32px;height:32px;border-radius:8px;background:#18181b;display:flex;align-items:center;justify-content:center;flex:0 0 auto;}
.sc-brand-txt{text-align:left;}
.sc-brand-name{font-size:15px;font-weight:700;color:#18181b;line-height:16px;white-space:nowrap;}
.sc-brand-host{font-size:11.5px;color:#71717a;font-family:'Geist Mono',ui-monospace,monospace;}
.sc-pill{margin-left:6px;display:inline-flex;align-items:center;font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:9999px;letter-spacing:.2px;}
.sc-card{background:#fff;border:1px solid #e4e4e7;border-radius:16px;box-shadow:0 20px 50px rgba(0,0,0,.10);overflow:hidden;}
.sc-pad{padding:30px 30px 26px;}
.sc-icon{width:52px;height:52px;border-radius:13px;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;}
h1.sc-h1{margin:0;text-align:center;font-size:21px;font-weight:700;color:#18181b;letter-spacing:-.3px;}
p.sc-sub{margin:8px auto 22px;text-align:center;font-size:13.5px;color:#71717a;line-height:20px;max-width:340px;}
.sc-foot-note{text-align:center;margin-top:16px;font-size:12px;color:#71717a;line-height:17px;}
.sc-card-foot{display:flex;gap:10px;padding:14px 22px;background:#fafafa;border-top:1px solid #e4e4e7;font-size:11.5px;color:#71717a;line-height:16px;align-items:flex-start;}
.sc-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;height:44px;border:0;border-radius:10px;background:#093df5;color:#fff;font-size:14px;font-weight:600;font-family:inherit;cursor:pointer;text-decoration:none;transition:background 140ms;}
.sc-btn:hover{background:#0731c4;}
.sc-btn:disabled{opacity:.5;cursor:not-allowed;}
.sc-btn-ghost{background:transparent;border:1px solid #e4e4e7;color:#18181b;}
.sc-btn-ghost:hover{background:#fafafa;}
.sc-code{font-family:'Geist Mono',ui-monospace,monospace;font-size:28px;font-weight:700;color:#18181b;letter-spacing:1px;}
.sc-code-label{font-size:11px;font-weight:600;color:#71717a;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;}
.sc-input{height:46px;width:100%;text-align:center;font-family:'Geist Mono',ui-monospace,monospace;font-size:22px;font-weight:600;letter-spacing:6px;border:1.5px solid #e4e4e7;border-radius:10px;outline:none;color:#18181b;background:#fafafa;}
.sc-input:focus{border-color:#093df5;background:#fff;box-shadow:0 0 0 3px #e0e7ff;}
.sc-tabs{display:flex;gap:6px;padding:4px;background:#fafafa;border-radius:10px;margin-bottom:20px;}
.sc-tab{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:7px;height:36px;border:0;border-radius:8px;cursor:pointer;font-family:inherit;font-size:12.5px;font-weight:500;background:transparent;color:#71717a;text-decoration:none;}
.sc-tab.on{font-weight:600;background:#fff;color:#18181b;box-shadow:0 1px 2px rgba(0,0,0,.08),0 0 0 1px #e4e4e7;}
.sc-err{margin-top:10px;font-size:12.5px;color:#dc2626;font-weight:500;text-align:center;}
.sc-ok{margin-top:10px;font-size:12.5px;color:#16a34a;font-weight:500;text-align:center;}
.sc-link{border:0;background:transparent;color:#093df5;cursor:pointer;font:inherit;font-weight:600;text-decoration:none;}
.sc-link:hover{text-decoration:underline;}
.sc-wait{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:20px;font-size:13px;color:#093df5;font-weight:500;}
`

// The Bailey hexagon mark used in the SceneShell brand row (white on the
// dark square), matching <Icon name="hexagon">.
const sceneHexagonSVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`

// sceneHost returns the server host line shown under the Bailey mark.
func sceneHost() string {
	if d := protectedHostnameDomain(); d != "" {
		return "bailey." + d
	}
	return "Bailey server"
}

// scenePage assembles a full SceneShell-style HTML document: the Bailey
// brand row (with an optional status pill), a centered white card holding
// the caller's body markup, and an optional footer note under the card.
// extraHead/extraBody let a scene add page-specific <head> or trailing
// <body> markup (e.g. a poller <script>).
func scenePage(title, pill string, tone scenePillTone, cardHTML, footNote, extraHead, extraBody string) string {
	pillHTML := ""
	if pill != "" {
		pillHTML = fmt.Sprintf(`<span class="sc-pill" style="background:%s;color:%s;">%s</span>`,
			tone.bg, tone.fg, html.EscapeString(pill))
	}
	foot := ""
	if footNote != "" {
		foot = `<div class="sc-foot-note">` + footNote + `</div>`
	}
	return fmt.Sprintf(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>%s</title>%s
<style>%s</style>%s</head>
<body>
<div class="sc-grid"></div>
<div class="sc-wrap"><div class="sc-col">
  <div class="sc-brand">
    <div class="sc-mark">%s</div>
    <div class="sc-brand-txt">
      <div class="sc-brand-name">Bailey</div>
      <div class="sc-brand-host">%s</div>
    </div>%s
  </div>
  <div class="sc-card">%s</div>
  %s
</div></div>
%s
</body></html>`,
		html.EscapeString(title), bitswanFavicon, sceneBaseCSS, extraHead,
		sceneHexagonSVG, html.EscapeString(sceneHost()), pillHTML,
		cardHTML, foot, extraBody)
}

// sceneSignedInRow renders the "Signed in as <email>" identity strip used
// at the top of the trust-this-device card (matches the ApprovalScene
// avatar row). Avatar is the user's first initial in a soft chip.
func sceneSignedInRow(email string) string {
	initial := "?"
	if e := strings.TrimSpace(email); e != "" {
		initial = strings.ToUpper(e[:1])
	}
	return fmt.Sprintf(`<div style="display:flex;align-items:center;gap:11px;padding:10px 12px;background:%s;border-radius:10px;margin-bottom:20px;">
  <span style="width:32px;height:32px;border-radius:9999px;flex:0 0 auto;background:#2a9d90;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;">%s</span>
  <div style="flex:1;min-width:0;">
    <div style="font-size:13px;font-weight:600;color:%s;">Signed in</div>
    <div style="font-size:11.5px;color:%s;font-family:'Geist Mono',ui-monospace,monospace;overflow:hidden;text-overflow:ellipsis;">%s</div>
  </div>
</div>`, scSurface, html.EscapeString(initial), scFg, scMuted, html.EscapeString(email))
}

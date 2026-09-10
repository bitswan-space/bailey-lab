package daemon

import (
	"fmt"
	"os"
	"path/filepath"
)

const dexThemeName = "bitswan"

const dexThemeStyles = `
:root {
  --bl-bg: #f4f4f5;
  --bl-surface: #ffffff;
  --bl-border: #e4e4e7;
  --bl-fg: #18181b;
  --bl-muted: #71717a;
  --bl-faint: #a1a1aa;
  --bl-primary: #2563eb;
  --bl-primary-hover: #1d4ed8;
  --bl-danger: #b91c1c;
  --bl-danger-bg: #fee2e2;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--bl-bg);
  color: var(--bl-fg);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
.bl-card {
  width: 100%;
  max-width: 420px;
  background: var(--bl-surface);
  border: 1px solid var(--bl-border);
  border-radius: 14px;
  padding: 30px 32px 26px;
}
.bl-logo { margin-bottom: 20px; line-height: 0; }
.bl-logo svg { width: 132px; height: auto; }
h1 {
  margin: 0 0 6px;
  font-size: 18px;
  line-height: 26px;
  font-weight: 650;
  letter-spacing: -0.01em;
}
.bl-sub { margin: 0 0 20px; font-size: 13.5px; line-height: 20px; color: var(--bl-muted); }
.bl-providers { display: flex; flex-direction: column; gap: 9px; }
.bl-provider {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 11px 14px;
  border: 1px solid var(--bl-border);
  border-radius: 10px;
  background: var(--bl-surface);
  color: var(--bl-fg);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  text-align: left;
  text-decoration: none;
  cursor: pointer;
  transition: border-color 120ms, background 120ms;
}
.bl-provider:hover { border-color: var(--bl-faint); background: #fafafa; }
.bl-provider:first-child {
  background: var(--bl-primary);
  border-color: var(--bl-primary);
  color: #ffffff;
}
.bl-provider:first-child:hover { background: var(--bl-primary-hover); border-color: var(--bl-primary-hover); }
.bl-field { display: block; margin-bottom: 12px; }
.bl-field span { display: block; font-size: 12.5px; font-weight: 600; margin-bottom: 5px; }
.bl-field input {
  width: 100%;
  height: 38px;
  padding: 0 11px;
  border: 1px solid var(--bl-border);
  border-radius: 9px;
  font: inherit;
  font-size: 14px;
  background: var(--bl-surface);
  color: var(--bl-fg);
}
.bl-field input:focus { outline: none; border-color: var(--bl-primary); box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.14); }
.bl-actions { display: flex; gap: 9px; margin-top: 18px; }
.bl-btn {
  padding: 10px 17px;
  border-radius: 9px;
  border: 1px solid var(--bl-border);
  background: var(--bl-surface);
  color: var(--bl-fg);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  text-decoration: none;
  display: inline-block;
}
.bl-btn--primary { background: var(--bl-primary); border-color: var(--bl-primary); color: #ffffff; }
.bl-btn--primary:hover { background: var(--bl-primary-hover); }
.bl-error {
  margin: 0 0 16px;
  padding: 12px 14px;
  border-radius: 10px;
  background: var(--bl-danger-bg);
  color: var(--bl-danger);
  font-size: 13px;
  line-height: 19px;
}
.bl-scopes { margin: 0 0 18px; padding-left: 18px; font-size: 13.5px; line-height: 21px; color: var(--bl-muted); }
.bl-foot { margin: 18px 0 0; font-size: 11.5px; line-height: 17px; color: var(--bl-faint); }
.bl-code {
  display: block;
  margin: 4px 0 0;
  font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 19px;
  letter-spacing: 0.08em;
  color: var(--bl-fg);
}
`

const dexTemplateHeader = `{{ define "header.html" }}<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{ issuer }}</title>
  <link rel="stylesheet" href="{{ url .ReqPath "theme/styles.css" }}">
</head>
<body>
  <main class="bl-card">
    <div class="bl-logo">%s</div>
{{ end }}`

const dexTemplateFooter = `{{ define "footer.html" }}
    <p class="bl-foot">Protected by Bitswan Bailey. Signing in proves who you are; a new device still has to be approved.</p>
  </main>
</body>
</html>
{{ end }}`

const dexTemplateLogin = `{{ template "header.html" . }}
<h1>Sign in to {{ issuer }}</h1>
<p class="bl-sub">Choose how you would like to sign in.</p>
<div class="bl-providers">
  {{ range $c := .Connectors }}
  <a class="bl-provider" href="{{ $c.URL }}" target="_self">{{ $c.Name }}</a>
  {{ end }}
</div>
{{ template "footer.html" . }}`

const dexTemplatePassword = `{{ template "header.html" . }}
<h1>Sign in to {{ issuer }}</h1>
<p class="bl-sub">Enter your credentials to continue.</p>
{{ if .Invalid }}<p class="bl-error">Those details were not recognised. Please try again.</p>{{ end }}
<form method="post" action="{{ .PostURL }}">
  <label class="bl-field"><span>{{ .UsernamePrompt }}</span>
    <input type="text" name="login" value="{{ .Username }}" autofocus autocomplete="username">
  </label>
  <label class="bl-field"><span>Password</span>
    <input type="password" name="password" autocomplete="current-password">
  </label>
  <input type="hidden" name="state" value="{{ .PostURL }}">
  <div class="bl-actions"><button type="submit" class="bl-btn bl-btn--primary">Sign in</button></div>
</form>
{{ template "footer.html" . }}`

const dexTemplateApproval = `{{ template "header.html" . }}
<h1>Allow access?</h1>
<p class="bl-sub">{{ .Client }} would like to:</p>
<ul class="bl-scopes">{{ range $s := .Scopes }}<li>{{ $s }}</li>{{ end }}</ul>
<form method="post">
  <input type="hidden" name="req" value="{{ .AuthReqID }}">
  <div class="bl-actions">
    <button type="submit" name="approval" value="approve" class="bl-btn bl-btn--primary">Allow</button>
    <button type="submit" name="approval" value="rejected" class="bl-btn">Cancel</button>
  </div>
</form>
{{ template "footer.html" . }}`

const dexTemplateError = `{{ template "header.html" . }}
<h1>{{ .ErrType }}</h1>
<p class="bl-error">{{ .ErrMsg }}</p>
<p class="bl-sub">If this keeps happening, ask an administrator to check the sign-in settings for this server.</p>
{{ template "footer.html" . }}`

const dexTemplateOOB = `{{ template "header.html" . }}
<h1>Sign-in code</h1>
<p class="bl-sub">Copy this code back into the application that asked for it.</p>
<code class="bl-code">{{ .Code }}</code>
{{ template "footer.html" . }}`

const dexTemplateDevice = `{{ template "header.html" . }}
<h1>Enter your device code</h1>
<p class="bl-sub">Type the code shown on the device you are signing in.</p>
<form method="post" action="{{ url .ReqPath "device/auth/verify_code" }}">
  <label class="bl-field"><span>Code</span><input type="text" name="user_code" value="{{ .UserCode }}" autofocus></label>
  <div class="bl-actions"><button type="submit" class="bl-btn bl-btn--primary">Continue</button></div>
</form>
{{ template "footer.html" . }}`

const dexTemplateDeviceSuccess = `{{ template "header.html" . }}
<h1>You are signed in</h1>
<p class="bl-sub">You can close this window and return to {{ .ClientName }}.</p>
{{ template "footer.html" . }}`

func writeDexWebTheme(dexDir string) (string, error) {
	webDir := filepath.Join(dexDir, "web")
	tplDir := filepath.Join(webDir, "templates")
	themeDir := filepath.Join(webDir, "themes", dexThemeName)
	staticDir := filepath.Join(webDir, "static")

	for _, d := range []string{tplDir, themeDir, staticDir} {
		if err := os.MkdirAll(d, 0755); err != nil {
			return "", fmt.Errorf("create dex web directory %s: %w", d, err)
		}
	}

	files := map[string]string{
		filepath.Join(webDir, "robots.txt"):          "User-agent: *\nDisallow: /\n",
		filepath.Join(tplDir, "header.html"):         fmt.Sprintf(dexTemplateHeader, bitswanLogoSVG),
		filepath.Join(tplDir, "footer.html"):         dexTemplateFooter,
		filepath.Join(tplDir, "login.html"):          dexTemplateLogin,
		filepath.Join(tplDir, "password.html"):       dexTemplatePassword,
		filepath.Join(tplDir, "approval.html"):       dexTemplateApproval,
		filepath.Join(tplDir, "error.html"):          dexTemplateError,
		filepath.Join(tplDir, "oob.html"):            dexTemplateOOB,
		filepath.Join(tplDir, "device.html"):         dexTemplateDevice,
		filepath.Join(tplDir, "device_success.html"): dexTemplateDeviceSuccess,
		filepath.Join(themeDir, "styles.css"):        dexThemeStyles,
		filepath.Join(themeDir, "logo.svg"):          bitswanLogoSVG,
	}
	for path, body := range files {
		if err := os.WriteFile(path, []byte(body), 0644); err != nil {
			return "", fmt.Errorf("write %s: %w", path, err)
		}
	}
	return webDir, nil
}

package daemon

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// Inner-content sync. The wrap's outer page (the one the user sees in
// their address bar and tab strip) needs to mirror three things from
// whatever the iframe is currently showing:
//
//   - the path  — so reloads resume on the same page instead of "/"
//   - the title — so the tab reads like the app, not "Bailey"
//   - the favicon — so the tab keeps the app's icon
//
// Outer and inner are different origins (the whole point of the
// outer/inner split), so the parent page can't read any of this from
// the iframe directly. Workaround: every HTML document served on the
// inner subdomain gets a small inline script appended that postMessages
// the current state to window.parent — on load, on every pushState /
// replaceState / popstate / hashchange, and whenever <title> mutates
// (SPAs update it long after load). The wrap listens (chrome_wrap.go),
// verifies the message origin, and mirrors the values.

const navSyncScript = `<script>(function(){
  var last = '';
  function fav(){
    var l = document.querySelector('link[rel="icon"],link[rel="shortcut icon"],link[rel~="icon"]');
    return (l && l.href) ? l.href : (location.origin + '/favicon.ico');
  }
  function post(){
    if (!window.parent || window.parent === window) return;
    var msg = {type:'bailey-nav',
               path: location.pathname + location.search + location.hash,
               title: document.title,
               favicon: fav()};
    var key = msg.path + '|' + msg.title + '|' + msg.favicon;
    if (key === last) return;
    last = key;
    try { window.parent.postMessage(msg, '*'); } catch (e) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', post);
  } else { post(); }
  var _push = history.pushState;
  history.pushState = function(){ var r = _push.apply(this, arguments); post(); return r; };
  var _replace = history.replaceState;
  history.replaceState = function(){ var r = _replace.apply(this, arguments); post(); return r; };
  window.addEventListener('popstate', post);
  window.addEventListener('hashchange', post);
  if (window.MutationObserver) {
    var head = document.head || document.documentElement;
    new MutationObserver(post).observe(head, {subtree:true, childList:true, characterData:true});
  }
})();</script>`

func appendNavSyncToHTML(body []byte) []byte {
	insertion := []byte(navSyncScript)
	if idx := bytes.LastIndex(bytes.ToLower(body), []byte("</body>")); idx >= 0 {
		out := make([]byte, 0, len(body)+len(insertion))
		out = append(out, body[:idx]...)
		out = append(out, insertion...)
		out = append(out, body[idx:]...)
		return out
	}
	return append(body, insertion...)
}

// injectNavSync mutates a reverse-proxied response to append the
// script before </body> (or at end-of-body if no </body> tag exists).
// Handles plain and gzipped bodies. Returns silently for responses we
// shouldn't touch.
func injectNavSync(resp *http.Response) {
	if resp == nil || resp.Body == nil {
		return
	}
	if !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html") {
		return
	}
	enc := strings.ToLower(strings.TrimSpace(resp.Header.Get("Content-Encoding")))

	raw, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		// Leave a closed body; the proxy will surface an error to the
		// caller. Restoring the original bytes would require buffering
		// earlier, which we don't.
		resp.Body = io.NopCloser(bytes.NewReader(nil))
		return
	}

	body := raw
	if enc == "gzip" {
		if gr, err := gzip.NewReader(bytes.NewReader(raw)); err == nil {
			if decompressed, err := io.ReadAll(gr); err == nil {
				body = decompressed
			}
			_ = gr.Close()
		}
	}

	body = appendNavSyncToHTML(body)

	if enc == "gzip" {
		var buf bytes.Buffer
		gw := gzip.NewWriter(&buf)
		_, _ = gw.Write(body)
		_ = gw.Close()
		body = buf.Bytes()
	}

	resp.Body = io.NopCloser(bytes.NewReader(body))
	resp.Header.Set("Content-Length", strconv.Itoa(len(body)))
	resp.ContentLength = int64(len(body))
}

// injectNavSyncMiddleware covers handler paths that bypass the reverse
// proxy's ModifyResponse — the gate's own HTML pages (share, denied)
// write straight to the ResponseWriter. On inner-host requests it
// buffers text/html responses and appends the nav-sync script;
// everything else (JSON, streams, assets) passes through unbuffered,
// preserving Flush() semantics for streaming endpoints.
func injectNavSyncMiddleware(inner http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isInnerHost(requestEndpointHost(r)) {
			inner.ServeHTTP(w, r)
			return
		}
		rec := &capturingWriter{
			real:    w,
			headers: http.Header{},
			status:  200,
			buf:     &bytes.Buffer{},
		}
		inner.ServeHTTP(rec, r)

		// Pass-through path already wrote headers + body straight to
		// `real`; nothing left to flush here.
		if rec.passthrough {
			return
		}

		body := rec.buf.Bytes()
		if strings.HasPrefix(rec.headers.Get("Content-Type"), "text/html") && len(body) > 0 {
			body = appendNavSyncToHTML(body)
			rec.headers.Set("Content-Length", strconv.Itoa(len(body)))
		}
		dst := w.Header()
		for k, vv := range rec.headers {
			dst[k] = append(dst[k][:0:0], vv...)
		}
		w.WriteHeader(rec.status)
		_, _ = w.Write(body)
	})
}

// capturingWriter routes writes one of two ways depending on the
// handler's Content-Type:
//
//   - text/html: buffer the whole body so the middleware can append
//     the nav-sync script before flushing.
//   - everything else: pass through to the real writer, preserving
//     Flush() semantics for streaming responses.
//
// The split is decided lazily on the first WriteHeader (or Write)
// because handlers typically call Header().Set before WriteHeader.
// Once `passthrough` is set, subsequent writes bypass the buffer.
//
// Does NOT embed http.ResponseWriter — that would make Header() return
// the real writer's headers, and the flush-back loop would then
// duplicate every entry. A private header map keeps the copies apart.
type capturingWriter struct {
	real        http.ResponseWriter
	headers     http.Header
	status      int
	wroteHeader bool
	buf         *bytes.Buffer
	passthrough bool // once true, Write goes straight to `real`
}

func (c *capturingWriter) Header() http.Header { return c.headers }

func (c *capturingWriter) WriteHeader(status int) {
	if c.wroteHeader {
		return
	}
	c.wroteHeader = true
	c.status = status
	// Decide here whether the body needs rewriting. If not, copy the
	// headers + status straight to the real writer now so subsequent
	// Write()s pass through unbuffered.
	if !strings.HasPrefix(c.headers.Get("Content-Type"), "text/html") {
		c.passthrough = true
		dst := c.real.Header()
		for k, vv := range c.headers {
			dst[k] = append(dst[k][:0:0], vv...)
		}
		c.real.WriteHeader(status)
	}
}

func (c *capturingWriter) Write(p []byte) (int, error) {
	if !c.wroteHeader {
		c.WriteHeader(200)
	}
	if c.passthrough {
		return c.real.Write(p)
	}
	return c.buf.Write(p)
}

// Flush makes capturingWriter satisfy http.Flusher so handler-side
// Flush() calls reach the real writer in passthrough mode. In
// buffering mode it's a no-op (text/html can't be partially flushed
// before the rewrite anyway).
func (c *capturingWriter) Flush() {
	if c.passthrough {
		if f, ok := c.real.(http.Flusher); ok {
			f.Flush()
		}
	}
}

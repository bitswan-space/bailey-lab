import React from 'react';
import QRCodeLib from 'qrcode';
// console-ui.jsx — shared primitives for the server console.
// Reuses the design-system palette + Icon/Btn/Pill from the workspace shell.

const { C, Icon, Btn, Pill, useLucide } = window.WD_SHELL;
const { useState: useS, useRef: useR, useEffect: useE } = React;

// ─── Avatar (initials chip) ─────────────────────────────────────────────────
function Avatar({ user, size = 28, ring }) {
  if (!user) return null;
  const initials = user.name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <span style={{
      width: size, height: size, borderRadius: 9999, flex: '0 0 auto',
      background: user.color, color: '#fff',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.4, fontWeight: 600, letterSpacing: 0.2,
      boxShadow: ring ? `0 0 0 2px #fff, 0 0 0 ${2 + (ring === true ? 1 : ring)}px ${user.color}55` : 'none',
      userSelect: 'none',
    }}>{initials}</span>
  );
}

// ─── Card ───────────────────────────────────────────────────────────────────
function Card({ children, style, pad = 20, onClick, hover }) {
  const [h, setH] = useS(false);
  return (
    <div onClick={onClick}
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{
        background: '#fff', border: `1px solid ${C.border}`, borderRadius: 12,
        padding: pad, cursor: onClick ? 'pointer' : 'default',
        boxShadow: hover && h ? '0 4px 14px rgba(0,0,0,0.07)' : 'var(--shadow-xs)',
        borderColor: hover && h ? C.borderHi : C.border,
        transition: 'box-shadow 160ms, border-color 160ms',
        ...style,
      }}>{children}</div>
  );
}

// ─── Page header ────────────────────────────────────────────────────────────
function PageHeader({ title, subtitle, actions, icon }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
      gap: 16, marginBottom: 22 }}>
      <div>
        <h1 style={{
          margin: 0, fontFamily: 'Roboto, Inter, sans-serif', fontWeight: 700,
          fontSize: 26, lineHeight: '32px', letterSpacing: '-0.4px', color: C.fg,
          display: 'flex', alignItems: 'center', gap: 10 }}>
          {icon && <Icon name={icon} size={22} color={C.muted} />}
          {title}
        </h1>
        {subtitle && <p style={{ margin: '6px 0 0', color: C.muted, fontSize: 14,
          maxWidth: 680, lineHeight: '20px' }}>{subtitle}</p>}
      </div>
      {actions && <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>{actions}</div>}
    </div>
  );
}

// ─── Field (label + control wrapper) ────────────────────────────────────────
function Field({ label, hint, children, style }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, ...style }}>
      {label && <span style={{ fontSize: 12, fontWeight: 600, color: C.fg }}>{label}</span>}
      {children}
      {hint && <span style={{ fontSize: 11.5, color: C.muted, lineHeight: '16px' }}>{hint}</span>}
    </label>
  );
}

function TextInput({ value, onChange, placeholder, mono, type = 'text', autoFocus, style }) {
  return (
    <input type={type} value={value} placeholder={placeholder} autoFocus={autoFocus}
      onChange={e => onChange(e.target.value)}
      style={{
        height: 36, padding: '0 12px', border: `1px solid ${C.border}`, borderRadius: 8,
        background: '#fff', fontFamily: mono ? 'Geist Mono, monospace' : 'inherit',
        fontSize: 13.5, color: C.fg, outline: 'none', width: '100%',
        transition: 'border-color 120ms, box-shadow 120ms', ...style,
      }}
      onFocus={e => { e.target.style.borderColor = C.primary; e.target.style.boxShadow = `0 0 0 3px ${C.primarySoft}`; }}
      onBlur={e => { e.target.style.borderColor = C.border; e.target.style.boxShadow = 'none'; }} />
  );
}

// ─── Modal (centered) ───────────────────────────────────────────────────────
function Modal({ open, onClose, title, subtitle, children, footer, width = 480, icon }) {
  useE(() => {
    if (!open) return;
    const onKey = e => { if (e.key === 'Escape') onClose && onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div onMouseDown={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(9,9,11,0.42)',
      backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center',
      justifyContent: 'center', padding: 24, animation: 'sc-fade 140ms ease',
    }}>
      <div onMouseDown={e => e.stopPropagation()} style={{
        width, maxWidth: '100%', maxHeight: '90vh', overflow: 'auto', background: '#fff',
        borderRadius: 14, border: `1px solid ${C.border}`,
        boxShadow: '0 24px 60px rgba(0,0,0,0.28)', animation: 'sc-pop 160ms cubic-bezier(0.2,0.9,0.3,1)',
      }}>
        {(title || icon) && (
          <div style={{ padding: '20px 22px 0', display: 'flex', gap: 13, alignItems: 'flex-start' }}>
            {icon && <div style={{
              width: 38, height: 38, borderRadius: 10, flex: '0 0 auto',
              background: C.primarySoft, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}><Icon name={icon} size={19} color={C.primary} /></div>}
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: C.fg, letterSpacing: '-0.2px' }}>{title}</h2>
              {subtitle && <p style={{ margin: '4px 0 0', fontSize: 13, color: C.muted, lineHeight: '18px' }}>{subtitle}</p>}
            </div>
            <button onClick={onClose} title="Close" style={{
              width: 28, height: 28, border: 0, background: 'transparent', borderRadius: 6,
              color: C.muted, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}><Icon name="x" size={16} /></button>
          </div>
        )}
        <div style={{ padding: '18px 22px 22px' }}>{children}</div>
        {footer && <div style={{
          padding: '14px 22px', borderTop: `1px solid ${C.border}`, background: C.surface,
          borderRadius: '0 0 14px 14px', display: 'flex', justifyContent: 'flex-end', gap: 8,
        }}>{footer}</div>}
      </div>
    </div>
  );
}

// ─── Segmented code input (overlay technique: real <input>, drawn boxes) ─────
// format: array of group lengths, e.g. [4,4] → "XXXX-XXXX". sep between groups.
function SegmentedCode({ format = [4, 4], value, onChange, onComplete, mono = true, size = 'md', auto }) {
  const total = format.reduce((a, b) => a + b, 0);
  const ref = useR(null);
  const [focused, setFocused] = useS(false);
  const dims = size === 'lg' ? { w: 42, h: 54, fs: 24 } : { w: 34, h: 44, fs: 19 };
  const clean = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, total);

  useE(() => { if (auto && ref.current) ref.current.focus(); }, [auto]);
  useE(() => { if (value.length === total && onComplete) onComplete(value); }, [value]);

  // Build the visual boxes grouped with separators
  const boxes = [];
  let idx = 0;
  format.forEach((len, gi) => {
    for (let i = 0; i < len; i++) {
      const ci = idx;
      const ch = value[ci] || '';
      const isCursor = focused && ci === value.length;
      boxes.push(
        <div key={`b${ci}`} style={{
          width: dims.w, height: dims.h, borderRadius: 8,
          border: `1.5px solid ${isCursor ? C.primary : (ch ? C.borderHi : C.border)}`,
          background: ch ? '#fff' : C.surface,
          boxShadow: isCursor ? `0 0 0 3px ${C.primarySoft}` : 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: mono ? 'Geist Mono, monospace' : 'inherit',
          fontSize: dims.fs, fontWeight: 600, color: C.fg,
          transition: 'border-color 120ms, box-shadow 120ms',
        }}>{ch}</div>
      );
      idx++;
    }
    if (gi < format.length - 1) boxes.push(
      <span key={`s${gi}`} style={{ color: C.mutedFg, fontSize: dims.fs, fontWeight: 600, padding: '0 2px' }}>–</span>
    );
  });

  return (
    <div onClick={() => ref.current && ref.current.focus()} style={{
      position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'text',
    }}>
      {boxes}
      <input ref={ref} value={value} inputMode="text" autoCapitalize="characters"
        onChange={e => onChange(clean(e.target.value))}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'text',
          border: 0, padding: 0, font: 'inherit', color: 'transparent' }} />
    </div>
  );
}

// ─── Fake-but-convincing QR (deterministic grid of squares) ─────────────────
function QRCode({ seed = 'bailey', size = 168, fg = '#09090b' }) {
  const N = 25;
  // deterministic PRNG from seed
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  const rand = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1000) / 1000; };
  const cell = size / N;
  const rects = [];
  const isFinder = (r, c) => (
    (r < 7 && c < 7) || (r < 7 && c >= N - 7) || (r >= N - 7 && c < 7)
  );
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    if (isFinder(r, c)) continue;
    if (rand() > 0.52) rects.push(
      <rect key={`${r}-${c}`} x={c * cell} y={r * cell} width={cell} height={cell} fill={fg} />
    );
  }
  const finder = (ox, oy) => (
    <g key={`f${ox}-${oy}`}>
      <rect x={ox * cell} y={oy * cell} width={7 * cell} height={7 * cell} fill={fg} />
      <rect x={(ox + 1) * cell} y={(oy + 1) * cell} width={5 * cell} height={5 * cell} fill="#fff" />
      <rect x={(ox + 2) * cell} y={(oy + 2) * cell} width={3 * cell} height={3 * cell} fill={fg} />
    </g>
  );
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', borderRadius: 8 }}>
      <rect x="0" y="0" width={size} height={size} fill="#fff" />
      {rects}
      {finder(0, 0)}{finder(N - 7, 0)}{finder(0, N - 7)}
    </svg>
  );
}

// ─── Real, scannable QR (encodes the given text, e.g. an otpauth:// URL) ─────
// Distinct from the decorative QRCode above (which is a seeded pattern used in
// prototype/preview scenes). QRImage renders an actually-scannable code so an
// authenticator app can read the live TOTP enrolment secret.
function QRImage({ value, size = 168 }) {
  const [src, setSrc] = useS('');
  const [err, setErr] = useS(false);
  useE(() => {
    let alive = true;
    setSrc(''); setErr(false);
    if (!value) return;
    QRCodeLib.toDataURL(value, { width: size, margin: 1, errorCorrectionLevel: 'M' })
      .then(url => { if (alive) setSrc(url); })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, [value, size]);
  if (err) {
    return (
      <div style={{ width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: `1px solid ${C.border}`, borderRadius: 8, color: C.red, fontSize: 12, textAlign: 'center', padding: 8 }}>
        Couldn't render QR
      </div>
    );
  }
  if (!src) {
    return <div style={{ width: size, height: size, borderRadius: 8, background: C.surface2 }} />;
  }
  return <img src={src} width={size} height={size} alt="Authenticator QR code" style={{ display: 'block', borderRadius: 8 }} />;
}

// ─── Toggle switch ──────────────────────────────────────────────────────────
function Toggle({ on, onChange, disabled }) {
  return (
    <button type="button" disabled={disabled} onClick={() => onChange(!on)} style={{
      width: 40, height: 23, borderRadius: 9999, border: 0, position: 'relative',
      background: on ? C.primary : C.borderHi, cursor: disabled ? 'not-allowed' : 'pointer',
      transition: 'background 160ms', flex: '0 0 auto', opacity: disabled ? 0.5 : 1,
    }}>
      <span style={{
        position: 'absolute', top: 2.5, left: on ? 19.5 : 2.5, width: 18, height: 18,
        borderRadius: 9999, background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
        transition: 'left 160ms',
      }} />
    </button>
  );
}

// ─── Device kind icon ───────────────────────────────────────────────────────
const DEVICE_ICON = { laptop: 'laptop', phone: 'smartphone', tablet: 'tablet', desktop: 'monitor' };
function DeviceIcon({ kind, size = 18, color }) {
  return <Icon name={DEVICE_ICON[kind] || 'monitor'} size={size} color={color} />;
}

// ─── Toast (host-level) ─────────────────────────────────────────────────────
function Toast({ toast }) {
  if (!toast) return null;
  const tones = {
    success: { bg: '#16a34a', icon: 'check' },
    danger:  { bg: C.red, icon: 'x' },
    info:    { bg: C.fg, icon: 'info' },
  };
  const t = tones[toast.tone] || tones.info;
  return (
    <div style={{
      position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 300,
      display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px 11px 13px',
      background: C.fg, color: '#fff', borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.3)',
      fontSize: 13.5, fontWeight: 500, animation: 'sc-toast 200ms cubic-bezier(0.2,0.9,0.3,1)',
    }}>
      <span style={{ width: 20, height: 20, borderRadius: 9999, background: t.bg,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}>
        <Icon name={t.icon} size={13} color="#fff" />
      </span>
      {toast.text}
    </div>
  );
}

// ─── Empty state ────────────────────────────────────────────────────────────
function EmptyState({ icon, title, text, action }) {
  return (
    <div style={{ textAlign: 'center', padding: '56px 24px', color: C.muted }}>
      <div style={{ width: 52, height: 52, borderRadius: 14, background: C.surface2,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
        <Icon name={icon} size={24} color={C.mutedFg} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, color: C.fg }}>{title}</div>
      {text && <div style={{ fontSize: 13, marginTop: 5, maxWidth: 360, marginInline: 'auto', lineHeight: '19px' }}>{text}</div>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}

// ─── Copy-to-clipboard inline button ────────────────────────────────────────
function CopyChip({ text, label }) {
  const [copied, setCopied] = useS(false);
  return (
    <button onClick={() => {
      if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
      setCopied(true); setTimeout(() => setCopied(false), 1400);
    }} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 10px',
      border: `1px solid ${C.border}`, borderRadius: 7, background: '#fff', cursor: 'pointer',
      fontFamily: 'Geist Mono, monospace', fontSize: 12.5, color: C.fg, fontWeight: 500,
    }}>
      {label || text}
      <Icon name={copied ? 'check' : 'copy'} size={13} color={copied ? '#16a34a' : C.mutedFg} />
    </button>
  );
}

// ─── Prototype hint pill (clearly-marked demo aid) ──────────────────────────
function ProtoHint({ children }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px',
      border: `1px dashed ${C.borderHi}`, borderRadius: 7, background: C.surface,
      fontSize: 11, color: C.muted, whiteSpace: 'nowrap',
    }}>
      <Icon name="sparkles" size={11} color={C.mutedFg} />
      {children}
    </span>
  );
}

// ─── Stat tile ──────────────────────────────────────────────────────────────
function Stat({ label, value, icon, tone = 'neutral', onClick, sub }) {
  const toneColor = { neutral: C.muted, primary: C.primary, danger: C.red, warning: C.amber, success: '#16a34a' }[tone];
  const [h, setH] = useS(false);
  return (
    <div onClick={onClick} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)} style={{
      background: '#fff', border: `1px solid ${h && onClick ? C.borderHi : C.border}`, borderRadius: 12,
      padding: 18, cursor: onClick ? 'pointer' : 'default', flex: 1, minWidth: 0,
      boxShadow: h && onClick ? '0 4px 14px rgba(0,0,0,0.06)' : 'none', transition: 'all 140ms',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.4, whiteSpace: 'nowrap' }}>{label}</span>
        <Icon name={icon} size={16} color={toneColor} style={{ flex: '0 0 auto' }} />
      </div>
      <div style={{ fontSize: 30, fontWeight: 700, color: C.fg, marginTop: 8, fontFamily: 'Roboto, Inter, sans-serif', letterSpacing: '-0.5px' }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: tone === 'neutral' ? C.muted : toneColor, marginTop: 2, fontWeight: 500 }}>{sub}</div>}
    </div>
  );
}

// ─── Right-side drawer ──────────────────────────────────────────────────────
function Drawer({ open, onClose, title, subtitle, icon, children, footer, width = 460 }) {
  useE(() => {
    if (!open) return;
    const onKey = e => { if (e.key === 'Escape') onClose && onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div onMouseDown={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(9,9,11,0.42)',
      backdropFilter: 'blur(2px)', display: 'flex', justifyContent: 'flex-end',
      animation: 'sc-fade 140ms ease',
    }}>
      <div onMouseDown={e => e.stopPropagation()} style={{
        width, maxWidth: '100%', height: '100%', background: '#fff',
        borderLeft: `1px solid ${C.border}`, boxShadow: '-12px 0 40px rgba(0,0,0,0.16)',
        display: 'flex', flexDirection: 'column', animation: 'sc-slide 200ms cubic-bezier(0.2,0.9,0.3,1)',
      }}>
        <div style={{ padding: '18px 22px', borderBottom: `1px solid ${C.border}`,
          display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          {icon && <div style={{
            width: 38, height: 38, borderRadius: 10, flex: '0 0 auto',
            background: C.primarySoft, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icon name={icon} size={19} color={C.primary} /></div>}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: C.fg, letterSpacing: '-0.2px' }}>{title}</h2>
            {subtitle && <p style={{ margin: '3px 0 0', fontSize: 13, color: C.muted }}>{subtitle}</p>}
          </div>
          <button onClick={onClose} title="Close" style={{
            width: 28, height: 28, border: 0, background: 'transparent', borderRadius: 6,
            color: C.muted, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}><Icon name="x" size={16} /></button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '20px 22px' }}>{children}</div>
        {footer && <div style={{
          padding: '14px 22px', borderTop: `1px solid ${C.border}`, background: C.surface,
          display: 'flex', justifyContent: 'flex-end', gap: 8,
        }}>{footer}</div>}
      </div>
    </div>
  );
}

// ─── Select (native, styled) ────────────────────────────────────────────────
function Select({ value, onChange, options, style }) {
  return (
    <div style={{ position: 'relative', ...style }}>
      <select value={value} onChange={e => onChange(e.target.value)} style={{
        height: 36, width: '100%', padding: '0 32px 0 12px', border: `1px solid ${C.border}`,
        borderRadius: 8, background: '#fff', fontFamily: 'inherit', fontSize: 13.5, color: C.fg,
        outline: 'none', cursor: 'pointer', appearance: 'none', WebkitAppearance: 'none',
      }}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <Icon name="chevron-down" size={14} color={C.mutedFg}
        style={{ position: 'absolute', right: 11, top: 11, pointerEvents: 'none' }} />
    </div>
  );
}

// ─── Avatar stack ───────────────────────────────────────────────────────────
function AvatarStack({ users, max = 4, size = 26 }) {
  const shown = users.slice(0, max);
  const extra = users.length - shown.length;
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center' }}>
      {shown.map((u, i) => (
        <span key={u.id} style={{ marginLeft: i ? -8 : 0, boxShadow: '0 0 0 2px #fff', borderRadius: 9999 }}>
          <Avatar user={u} size={size} />
        </span>
      ))}
      {extra > 0 && (
        <span style={{
          marginLeft: -8, width: size, height: size, borderRadius: 9999, background: C.surface2,
          color: C.muted, fontSize: size * 0.36, fontWeight: 600, boxShadow: '0 0 0 2px #fff',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', zIndex: 1,
        }}>+{extra}</span>
      )}
    </div>
  );
}

// ─── Inline load / error banners (for live-wired views) ─────────────────────
// A small non-blocking strip rendered above a list when a fetch is in
// flight or failed — so a failed API call shows context + a Retry,
// never a blank screen.
function LoadBanner({ label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 14px', marginBottom: 14,
      border: `1px solid ${C.border}`, background: C.surface, borderRadius: 10, fontSize: 12.5, color: C.muted }}>
      <Icon name="loader" size={14} color={C.mutedFg} />
      <span>{label || 'Loading…'}</span>
    </div>
  );
}

function ErrorBanner({ message, onRetry }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', marginBottom: 14,
      border: `1px solid ${C.red}55`, background: C.redSoft, borderRadius: 10 }}>
      <Icon name="alert-triangle" size={15} color={C.red} style={{ flex: '0 0 auto' }} />
      <span style={{ flex: 1, fontSize: 12.5, color: C.red, lineHeight: '17px' }}>
        {message || "Couldn't load this from the server."}
      </span>
      {onRetry && <Btn variant="default" size="sm" leftIcon="refresh-cw" onClick={onRetry}>Retry</Btn>}
    </div>
  );
}

// LiveState renders the right banner for a {load,error} pair, or nothing
// when the list loaded cleanly. status: 'idle'|'loading'|'ok'|'error'.
function LiveState({ status, error, label, onRetry }) {
  if (status === 'error') return <ErrorBanner message={error} onRetry={onRetry} />;
  if (status === 'loading' || status === 'idle') return <LoadBanner label={label} />;
  return null;
}

window.SC_UI = {
  Avatar, Card, PageHeader, Field, TextInput, Modal, SegmentedCode, QRCode, QRImage,
  Toggle, DeviceIcon, Toast, EmptyState, CopyChip, ProtoHint, Stat,
  Drawer, Select, AvatarStack, LoadBanner, ErrorBanner, LiveState,
};
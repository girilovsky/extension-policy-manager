// Small reusable UI primitives

const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ---------- Icons ----------
const Icon = {
  Search: (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>,
  Plus:   (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 5v14M5 12h14"/></svg>,
  X:      (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M18 6 6 18M6 6l12 12"/></svg>,
  Copy:   (p) => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>,
  Check:  (p) => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M20 6 9 17l-5-5"/></svg>,
  Download:(p) => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>,
  Shield: (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/></svg>,
  Ban:    (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/></svg>,
  Code:   (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/></svg>,
  Apple:  (p) => <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M17.5 12.5c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.3 2.5 1.3-.1 1.8-.9 3.4-.9 1.6 0 2 .9 3.4.8 1.4 0 2.3-1.2 3.2-2.5 1-1.4 1.4-2.8 1.4-2.9-.1 0-2.7-1.1-2.7-4.1zM15 4.7c.7-.9 1.2-2.1 1.1-3.3-1 .1-2.3.7-3 1.6-.6.7-1.3 2-1.1 3.2 1.2.1 2.3-.6 3-1.5z"/></svg>,
  Win:    (p) => <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M3 5.5 11 4.4v7.1H3zm0 7.1h8v7.1L3 18.6zm9-8.3 11-1.4v8.6H12zM12 12.6h11V21l-11-1.4z"/></svg>,
  Info:   (p) => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/></svg>,
  Pin:    (p) => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 17v5M9 10.76V5l-1-1h8l-1 1v5.76l2 2.24v2H7v-2z"/></svg>,
  Sparkle:(p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M12 2 13.5 9 20 10l-6.5 1.5L12 18l-1.5-6.5L4 10l6.5-1.5z"/></svg>,
  Filter: (p) => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 5h18l-7 9v6l-4-2v-4z"/></svg>,
  Pencil: (p) => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>,
  Spinner: (p) => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" {...p}><path d="M21 12a9 9 0 1 1-6.2-8.55" /></svg>,
  Link:   (p) => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1 1"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1-1"/></svg>,
  Globe:  (p) => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>,
  Upload: (p) => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 15V3m0 0-4 4m4-4 4 4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>,
  AlertTriangle: (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="m12 2 10 18H2L12 2Z"/><path d="M12 9v4M12 17h.01"/></svg>,
  File:   (p) => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>,
  Cloud:  (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 15V3m0 0-3 3m3-3 3 3"/><path d="M7 10.2A5.5 5.5 0 1 0 12 19h5a4 4 0 0 0 .7-7.9A6 6 0 0 0 7 10.2Z"/></svg>,
  ChevronsLeft:  (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="m11 17-5-5 5-5"/><path d="m18 17-5-5 5-5"/></svg>,
  ChevronsRight: (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/></svg>,
  Sliders: (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M4 8h16M4 16h16"/><circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none"/><circle cx="16" cy="16" r="2.5" fill="currentColor" stroke="none"/></svg>,
  RefreshSparkle: (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M21 12a9 9 0 0 0-9-9 9 9 0 0 0-6.36 2.64L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9 9 0 0 0 6.36-2.64L21 16"/><path d="M16 16h5v5"/><path d="m12 8 .8 3.2L16 12l-3.2.8L12 16l-.8-3.2L8 12l3.2-.8z" fill="currentColor" stroke="none"/></svg>,
  Chrome: (p) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" {...p}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/><path d="M12 8.5h7.8M9 13.7l-3.9 6.7M14.9 13.7 11 20.6"/></svg>,
  Edge:   (p) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" {...p}><path d="M3.6 14.5c0 4 3.5 6.5 7.4 6.5 2.5 0 4.6-1 5.5-2.4-2.6 1-7-.2-7.5-3.6-.4-2.7 1.6-4.5 3.6-4.7 2.6-.3 4.5 1.4 5 2.5.5-1.6.4-2.5.4-3.4C18 4.5 15.3 3 12 3 6.8 3 3.6 7.5 3.6 11.5"/></svg>,
  Lock:   (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>,
  Unlock: (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>,
  Sun:    (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>,
  Moon:   (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>,
  ArrowUp:    (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 19V5M5 12l7-7 7 7"/></svg>,
  History:    (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.36 2.64L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 3"/></svg>,
  RotateCcw:  (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.36 2.64L3 8"/><path d="M3 3v5h5"/></svg>,
  ChevronDown:(p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="m6 9 6 6 6-6"/></svg>,
};

// ---------- Toast ----------
const ToastContext = React.createContext({push: () => {}});

function ToastHost({ toasts, dismiss }) {
  return (
    <div className="toast-host">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast--${t.kind}`} onClick={() => dismiss(t.id)}>
          <span className="toast-dot" />
          <span>{t.msg}</span>
        </div>
      ))}
    </div>
  );
}

function useToasts(){
  const [toasts, setToasts] = useState([]);
  const push = useCallback((msg, kind='ok') => {
    const id = Math.random().toString(36).slice(2);
    setToasts(t => [...t, {id, msg, kind}]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 2400);
  }, []);
  const dismiss = useCallback((id) => setToasts(t => t.filter(x => x.id !== id)), []);
  return { toasts, push, dismiss };
}

// ---------- Copy button ----------
function CopyButton({ getText, label='Copy' }) {
  const [copied, setCopied] = useState(false);
  const toast = React.useContext(ToastContext);
  const onClick = () => {
    const text = typeof getText === 'function' ? getText() : getText;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      toast.push('Copied to clipboard', 'ok');
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button className="btn btn--ghost btn--sm" onClick={onClick} aria-label={label}>
      {copied ? <Icon.Check /> : <Icon.Copy />}
      <span>{copied ? 'Copied' : label}</span>
    </button>
  );
}

// ---------- Syntax highlighting ----------
function highlightJSON(src){
  // Order matters; use placeholders to avoid double-escaping
  const escaped = src.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return escaped
    .replace(/("(?:[^"\\]|\\.)*")(\s*:)/g, '<span class="t-key">$1</span>$2')
    .replace(/:\s*("(?:[^"\\]|\\.)*")/g, (m, q) => ': <span class="t-str">' + q + '</span>')
    .replace(/\b(true|false|null)\b/g, '<span class="t-bool">$1</span>')
    .replace(/\b(\d+)\b/g, '<span class="t-num">$1</span>');
}

function highlightXML(src){
  const escaped = src.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return escaped
    .replace(/(&lt;\?xml[^?]*\?&gt;)/g, '<span class="t-decl">$1</span>')
    .replace(/(&lt;!DOCTYPE[^&]*?&gt;)/g, '<span class="t-decl">$1</span>')
    .replace(/(&lt;\/?)([a-zA-Z][\w:-]*)/g, '$1<span class="t-tag">$2</span>')
    .replace(/&gt;([^&\n]+?)(&lt;\/)/g, (m, content, tail) => '&gt;<span class="t-text">' + content + '</span>' + tail);
}

function CodeBlock({ text, lang }) {
  const html = useMemo(() => {
    if (lang === 'json') return highlightJSON(text);
    if (lang === 'xml')  return highlightXML(text);
    return text.replace(/&/g,'&amp;').replace(/</g,'&lt;');
  }, [text, lang]);
  // Line numbers
  const lineCount = useMemo(() => text.split('\n').length, [text]);
  const lines = useMemo(() => Array.from({length: lineCount}, (_,i)=>i+1).join('\n'), [lineCount]);
  return (
    <div className="code">
      <pre className="code__gutter" aria-hidden="true">{lines}</pre>
      <pre className="code__src" dangerouslySetInnerHTML={{__html: html}} />
    </div>
  );
}

// ---------- Pill / Badge ----------
function ModeBadge({ mode }) {
  const map = {
    allowed:        { cls: 'badge--allowed',  label: 'Allowed' },
    force_installed:{ cls: 'badge--force',    label: 'Force install' },
    removed:        { cls: 'badge--blocked',  label: 'Blocked' },
  };
  const m = map[mode] || map.allowed;
  return <span className={`badge ${m.cls}`}><span className="badge-dot"/>{m.label}</span>;
}

// ---------- Avatar from extension ID ----------
function ExtAvatar({ id, name, iconUrl }) {
  const [broken, setBroken] = useState(false);
  // deterministic hue from id
  const hue = useMemo(() => {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
    return h;
  }, [id]);
  const initials = useMemo(() => {
    if (!name || name === 'Unknown') return id.slice(0,2).toUpperCase();
    const parts = name.split(/\s+/).filter(Boolean);
    return (parts[0][0] + (parts[1]?.[0] || parts[0][1] || '')).toUpperCase();
  }, [name, id]);
  if (iconUrl && !broken) {
    return (
      <div className="ext-avatar ext-avatar--img">
        <img src={iconUrl} alt="" onError={() => setBroken(true)} />
      </div>
    );
  }
  const bg = `oklch(0.94 0.04 ${hue})`;
  const fg = `oklch(0.38 0.12 ${hue})`;
  return (
    <div className="ext-avatar" style={{background: bg, color: fg}}>
      {initials}
    </div>
  );
}

Object.assign(window, {
  Icon, ToastContext, ToastHost, useToasts,
  CopyButton, CodeBlock, ModeBadge, ExtAvatar,
  highlightJSON, highlightXML,
});

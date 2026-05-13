// parsers.js — Parse imported policy config files
// Supports:
//   1. Intune JSON  { "id": {"installation_mode": "..."}, ... }
//   2. Dirty JSON   — text with junk lines before/after the JSON object
//   3. Comma / newline separated IDs  "id1, id2, id3"
//   4. macOS .mobileconfig (plist XML)

window.PARSERS = (function(){
  const ID_REGEX = /^[a-p]{32}$/;
  // Looser: 30-34 chars of lowercase a-z — catches typos like 33-char IDs
  const ID_LOOSE = /^[a-z]{30,34}$/;

  // -------- Plist XML → JS object --------
  function parsePlistNode(node) {
    if (!node) return null;
    switch (node.tagName) {
      case 'dict': {
        const obj = {};
        const ch = [...node.children].filter(n => n.nodeType === 1);
        for (let i = 0; i < ch.length; i++) {
          if (ch[i].tagName === 'key' && ch[i + 1]) {
            obj[ch[i].textContent] = parsePlistNode(ch[i + 1]);
            i++;
          }
        }
        return obj;
      }
      case 'array':
        return [...node.children].filter(n => n.nodeType === 1).map(parsePlistNode);
      case 'string': return node.textContent;
      case 'integer': return parseInt(node.textContent, 10);
      case 'real':    return parseFloat(node.textContent);
      case 'true':    return true;
      case 'false':   return false;
      default:        return null;
    }
  }

  function parsePlist(xmlStr) {
    const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
    if (doc.querySelector('parsererror')) return null;
    const plist = doc.querySelector('plist');
    if (!plist) return null;
    const first = [...plist.children].find(n => n.nodeType === 1);
    return parsePlistNode(first);
  }

  // -------- Extract entries from .mobileconfig --------
  function parseMobileconfig(text) {
    const plist = parsePlist(text);
    if (!plist) return { chrome: [], edge: [], error: 'Invalid plist / XML' };

    const payloads = Array.isArray(plist.PayloadContent) ? plist.PayloadContent : [];
    if (payloads.length === 0) return { chrome: [], edge: [], error: 'No PayloadContent array found' };

    const chrome = [], edge = [];
    for (const p of payloads) {
      if (!p || typeof p !== 'object') continue;
      const type = p.PayloadType || '';
      const bucket = type.includes('Chrome') ? chrome : type.includes('Edge') ? edge : null;
      if (!bucket) continue;

      const settings = p.ExtensionSettings;
      if (!settings || typeof settings !== 'object') continue;

      for (const [id, cfg] of Object.entries(settings)) {
        if (id === '*') continue;
        const mode = (cfg && typeof cfg === 'object' && cfg.installation_mode) || 'allowed';
        if (ID_REGEX.test(id)) {
          bucket.push({ id, mode, valid: true });
        } else if (ID_LOOSE.test(id)) {
          bucket.push({ id, mode, valid: false, warning: `Suspicious ID "${id}" (${id.length} chars)` });
        }
      }
    }

    if (chrome.length === 0 && edge.length === 0) {
      return { chrome, edge, error: 'No extension IDs found in ExtensionSettings' };
    }
    return { chrome, edge, error: null };
  }

  // -------- Try to extract JSON object from dirty text --------
  // Handles: "settings (User)\n{ ... }", or text with leading/trailing junk
  function extractJSON(text) {
    const start = text.indexOf('{');
    const end   = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(text.substring(start, end + 1));
    } catch {
      return null;
    }
  }

  // -------- Extract entries from JSON (Intune ExtensionSettings) --------
  function parseIntuneJSON(text) {
    const obj = extractJSON(text);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return { entries: [], warnings: [], error: 'Could not find a valid JSON object in the text' };
    }

    const entries = [], warnings = [];
    for (const [id, cfg] of Object.entries(obj)) {
      if (id === '*') continue;
      const mode = (cfg && typeof cfg === 'object' && cfg.installation_mode) || 'allowed';
      if (ID_REGEX.test(id)) {
        entries.push({ id, mode });
      } else if (ID_LOOSE.test(id)) {
        entries.push({ id, mode });
        warnings.push(`"${id}" — ${id.length} chars (expected 32)`);
      }
    }

    if (entries.length === 0) {
      return { entries, warnings, error: 'No extension IDs found' };
    }
    return { entries, warnings, error: null };
  }

  // -------- Parse comma / newline / space separated IDs --------
  function parseIdList(text) {
    // Split on commas, newlines, spaces, semicolons
    const tokens = text.split(/[,\s;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    const entries = [], warnings = [];

    for (const tok of tokens) {
      if (ID_REGEX.test(tok)) {
        entries.push({ id: tok, mode: 'blocked' });
      } else if (ID_LOOSE.test(tok)) {
        entries.push({ id: tok, mode: 'blocked' });
        warnings.push(`"${tok}" — ${tok.length} chars (expected 32)`);
      }
      // skip non-ID tokens silently (headers, labels, etc.)
    }

    if (entries.length === 0) {
      return { entries, warnings, error: 'No valid extension IDs found in the text' };
    }
    return { entries, warnings, error: null };
  }

  // -------- Auto-detect format and parse --------
  function parseConfigFile(text, filename) {
    const fn = (filename || '').toLowerCase();
    const trimmed = text.trimStart();

    // 1. Detect mobileconfig / plist XML
    if (fn.endsWith('.mobileconfig') || fn.endsWith('.xml') ||
        trimmed.startsWith('<?xml') || trimmed.startsWith('<!DOCTYPE plist')) {
      const r = parseMobileconfig(text);
      return { type: 'mobileconfig', chrome: r.chrome, edge: r.edge, error: r.error };
    }

    // 2. Detect JSON — look for { anywhere in the text (handles dirty prefixes)
    if (text.includes('{') && text.includes('}')) {
      const r = parseIntuneJSON(text);
      if (!r.error) {
        return { type: 'json', entries: r.entries, warnings: r.warnings, error: null };
      }
      // JSON parse failed — fall through to ID list
    }

    // 3. Try comma / newline separated IDs
    const r = parseIdList(text);
    if (!r.error) {
      return { type: 'id-list', entries: r.entries, warnings: r.warnings, error: null };
    }

    return { type: 'unknown', error: 'No extension IDs found — expected JSON, .mobileconfig, or comma-separated IDs' };
  }

  return { parseConfigFile, extractJSON };
})();

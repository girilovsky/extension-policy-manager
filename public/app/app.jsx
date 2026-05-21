// Main app — Extension Policy Manager (unified allowlist/blocklist)

const { useState, useEffect, useRef, useMemo, useCallback } = React;

const ID_REGEX = /^[a-p]{32}$/;
const isValidId = (s) => !s || ID_REGEX.test(s.trim().toLowerCase());

// Fuzzy-match threshold for proposing duplicate-extension merges.
// 0.7 means strings sharing ~70% characters (Levenshtein) — empirical sweet spot.
const MERGE_SIMILARITY_THRESHOLD = 0.7;

// After importing old configs, use a lower bar (30%) for merge proposals —
// Chrome and Edge store pages often title the same extension differently.
const IMPORT_MERGE_SIMILARITY_THRESHOLD = 0.3;

// Network-lookup timeout (ms) for r.jina.ai store-page scraping.
const LOOKUP_TIMEOUT_MS = 8000;
const POLICY_NAME_FILTER = window.INTUNE?.DEFAULT_POLICY_NAME_FILTER || 'Browser Extension';
const isBrowserExtensionPolicy = (policy) =>
  !!policy?.browserExtensionSettings ||
  (policy?.name || '').toLowerCase().includes(POLICY_NAME_FILTER.toLowerCase());

function policyMatchesKey(key, policy) {
  if (!policy || !isBrowserExtensionPolicy(policy)) return false;
  const needsWindows = key.startsWith('win-');
  if (needsWindows && policy.type !== 'settingsCatalog') return false;
  if (!needsWindows && policy.type !== 'macOSCustom') return false;
  return true;
}

function scorePolicyForKey(key, policy) {
  if (!policyMatchesKey(key, policy)) return -1;
  const name = (policy.name || '').toLowerCase();
  const wantsAllow = key.includes('allow');
  const wantsBlock = key.includes('block');
  const wantsChrome = key.includes('chrome');
  const wantsEdge = key.includes('edge');
  let score = 0;
  if (wantsAllow && name.includes('allow')) score += 8;
  if (wantsBlock && name.includes('block')) score += 8;
  if (wantsChrome && name.includes('chrome')) score += 4;
  if (wantsEdge && name.includes('edge')) score += 4;
  if ((wantsChrome || wantsEdge) && name.includes('browser extension')) score += 1;
  if (key.startsWith('win-') && name.includes('windows')) score += 2;
  if (key.startsWith('mac-') && (name.includes('macos') || name.includes('mac os'))) score += 2;
  if (policy.browserExtensionSettings) score += 1;
  return score;
}

function findBestPolicyForKey(key, policies) {
  return policies
    .filter(p => policyMatchesKey(key, p))
    .map(p => ({ policy: p, score: scorePolicyForKey(key, p) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.policy.name.localeCompare(b.policy.name))[0]?.policy || null;
}

function buildPolicyMap(keys, policies, savedMap = {}) {
  const next = {};
  for (const key of keys) {
    const savedId = savedMap[key];
    if (savedId && policies.some(p => p.id === savedId && policyMatchesKey(key, p))) {
      next[key] = savedId;
      continue;
    }
    next[key] = findBestPolicyForKey(key, policies)?.id || '';
  }
  return next;
}

// Server-side persistence via /api/data
async function loadDataFromServer() {
  try {
    const r = await fetch('/api/data');
    if (!r.ok) return null;
    const d = await r.json();
    if (d && Array.isArray(d.allowlist) && Array.isArray(d.blocklist)) return d;
  } catch {}
  return null;
}

function saveData(data) {
  // Fire-and-forget PUT to server
  fetch('/api/data', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).catch(() => {});
}

function exportDataAsFile(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `extension-policy-data-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 200);
}

function parseImportText(text) {
  try {
    const parsed = JSON.parse(text.trim());
    if (Array.isArray(parsed.allowlist) && Array.isArray(parsed.blocklist)) return parsed;
  } catch {}
  return null;
}

function App() {
  const [data, setData] = useState(() => structuredClone(window.INITIAL_DATA));
  const [section, setSection] = useState('allowlist');
  const [tab, setTab] = useState('list');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [editingKey, setEditingKey] = useState(null);
  const [deployOpen, setDeployOpen] = useState(false);
  const [settingsHasLock, setSettingsHasLock] = useState(false);
  const [settingsUnlocked, setSettingsUnlocked] = useState(
    () => !!sessionStorage.getItem('epm_settings_unlock_token')
  );
  const [hideBlocklist, setHideBlocklist] = useState(() => localStorage.getItem('epm_hide_blocklist') === '1');
  const [allowDeleteDeployed, setAllowDeleteDeployed] = useState(() => localStorage.getItem('epm_allow_delete_deployed') === '1');
  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem('epm_dark_mode');
    const dark = saved !== null ? saved === '1' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'dark' : '';
    return dark;
  });
  const toggleDark = () => {
    const next = !darkMode;
    const root = document.documentElement;
    root.classList.add('theme-transitioning');
    void root.offsetHeight;
    root.dataset.theme = next ? 'dark' : '';
    localStorage.setItem('epm_dark_mode', next ? '1' : '0');
    setTimeout(() => root.classList.remove('theme-transitioning'), 400);
    setDarkMode(next);
  };
  const [settingsTab, setSettingsTab] = useState('intune');
  const [serverDataLoaded, setServerDataLoaded] = useState(false);
  const [unlockModal, setUnlockModal] = useState(null); // { title, description, confirmLabel, onConfirm } | null
  const [confirmModal, setConfirmModal] = useState(null); // { title, description, confirmLabel, onConfirm } | null
  const [autoLockMs, setAutoLockMs] = useState(() => {
    const v = localStorage.getItem('epm_auto_lock_ms');
    return v !== null ? Number(v) : 30 * 60 * 1000;
  }); // server value overrides this on mount (see useEffect below)
  const [lockIn, setLockIn] = useState('');
  const [lockProgress, setLockProgress] = useState(0); // 0 = full ring, 1 = empty
  const autoLockTimer = useRef(null);
  const unlockTime = useRef(null);
  const mainRef = useRef(null);
  const toasts = useToasts();

  // Load saved data from server on mount
  useEffect(() => {
    loadDataFromServer().then(d => {
      if (d) setData(d);
      setServerDataLoaded(true);
    });
    fetch('/api/settings-lock').then(r => r.json()).then(d => {
      setSettingsHasLock(d.hasPassword);
      if (d.autoLockMs !== null && d.autoLockMs !== undefined) {
        setAutoLockMs(d.autoLockMs);
        localStorage.setItem('epm_auto_lock_ms', String(d.autoLockMs));
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = e => {
      if (localStorage.getItem('epm_dark_mode') !== null) return;
      const root = document.documentElement;
      root.classList.add('theme-transitioning');
      void root.offsetHeight;
      root.dataset.theme = e.matches ? 'dark' : '';
      setTimeout(() => root.classList.remove('theme-transitioning'), 400);
      setDarkMode(e.matches);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  useEffect(() => { setSearch(''); setFilter('all'); setTab('list'); setEditingKey(null); if (mainRef.current) mainRef.current.scrollTop = 0; }, [section]);
  useEffect(() => { setEditingKey(null); }, [tab]);

  // Auto-save to server on every change
  useEffect(() => {
    if (serverDataLoaded) saveData(data);
  }, [data, serverDataLoaded]);

  // Auto-lock timer: lock settings after autoLockMs of being unlocked.
  // Deadline is persisted to sessionStorage so it survives page refresh.
  useEffect(() => {
    clearTimeout(autoLockTimer.current);
    setLockIn('');
    setLockProgress(0);
    if (!settingsUnlocked || autoLockMs <= 0) {
      sessionStorage.removeItem('epm_auto_lock_deadline');
      return;
    }
    // Restore saved deadline if it was set with the same autoLockMs, otherwise start fresh.
    let deadline;
    try {
      const saved = JSON.parse(sessionStorage.getItem('epm_auto_lock_deadline') || 'null');
      deadline = (saved?.autoLockMs === autoLockMs && saved?.deadline > Date.now())
        ? saved.deadline
        : Date.now() + autoLockMs;
    } catch { deadline = Date.now() + autoLockMs; }
    sessionStorage.setItem('epm_auto_lock_deadline', JSON.stringify({ deadline, autoLockMs }));
    unlockTime.current = deadline;

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      sessionStorage.removeItem('epm_auto_lock_deadline');
      window.EPM_API?.clearUnlockToken();
      setSettingsUnlocked(false);
      return;
    }
    autoLockTimer.current = setTimeout(() => {
      sessionStorage.removeItem('epm_auto_lock_deadline');
      window.EPM_API?.clearUnlockToken();
      setSettingsUnlocked(false);
    }, remaining);
    const tick = setInterval(() => {
      const rem = unlockTime.current - Date.now();
      if (rem <= 0) { clearInterval(tick); return; }
      const totalSec = Math.ceil(rem / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      setLockIn(
        h > 0
          ? `${h}h ${m}m ${s < 10 ? '0' : ''}${s}s`
          : m > 0 ? `${m}m ${s < 10 ? '0' : ''}${s}s` : `${s}s`
      );
      setLockProgress(Math.max(0, Math.min(1, 1 - rem / autoLockMs)));
    }, 1000);
    return () => { clearTimeout(autoLockTimer.current); clearInterval(tick); };
  }, [settingsUnlocked, autoLockMs]);

  const isBlock = section === 'blocklist';
  const items = isBlock ? data.blocklist : data.allowlist;

  const counts = useMemo(() => ({
    allowlist: data.allowlist.length,
    blocklist: data.blocklist.length,
  }), [data]);

  const [identifying, setIdentifying] = useState(false);
  const [identifyProgress, setIdentifyProgress] = useState({ done: 0, total: 0 });
  const [mergeProposals, setMergeProposals] = useState([]); // [{ a: idx, b: idx, score }]

  // Cancellation token for in-flight identify operations — flips when section/tab changes.
  const identifyToken = useRef(0);
  useEffect(() => {
    identifyToken.current += 1;  // invalidate any pending identify loop
    setIdentifying(false);
    setIdentifyProgress({ done: 0, total: 0 });
    setMergeProposals([]);
  }, [section]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(e => {
      if (q) {
        const hay = (e.name + ' ' + e.chromeId + ' ' + e.edgeId).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (filter === 'all') return true;
      if (filter === 'both')        return e.chromeId && e.edgeId;
      if (filter === 'chrome-only') return e.chromeId && !e.edgeId;
      if (filter === 'edge-only')   return !e.chromeId && e.edgeId;
      if (filter === 'force')       return e.mode === 'force_installed';
      if (filter === 'unknown')     return e.name === 'Unknown' || !e.name;
      return true;
    });
  }, [items, search, filter]);

  // Stable composite key — independent of array position.
  const keyOf = (e) => `${e.chromeId || '_'}::${e.edgeId || '_'}`;

  const doRemoveAt = (idx) => {
    setData(d => {
      const next = structuredClone(d);
      const list = isBlock ? next.blocklist : next.allowlist;
      list.splice(idx, 1);
      return next;
    });
    toasts.push('Removed from list', 'warn');
  };

  const removeAt = (idx) => {
    const item = items[idx];
    const name = item?.name || 'this extension';
    if (settingsHasLock && !settingsUnlocked && item?.deployedAt && !allowDeleteDeployed) {
      setUnlockModal({
        title: 'Remove extension',
        description: `Enter the settings password to remove "${name}" from the list.`,
        confirmLabel: 'Remove',
        onConfirm: () => { doRemoveAt(idx); setUnlockModal(null); },
      });
      return;
    }
    setConfirmModal({
      title: 'Remove extension',
      description: `Remove "${name}" from the list?`,
      confirmLabel: 'Remove',
      onConfirm: () => { doRemoveAt(idx); setConfirmModal(null); },
    });
  };

  const handleDeployed = () => {
    const now = new Date().toISOString();
    setData(d => {
      const next = structuredClone(d);
      const listKey = isBlock ? 'blocklist' : 'allowlist';
      next[listKey] = next[listKey].map(item =>
        item.deployedAt ? item : { ...item, deployedAt: now }
      );
      return next;
    });
  };

  const updateAt = (idx, patch) => {
    setData(d => {
      const next = structuredClone(d);
      const list = isBlock ? next.blocklist : next.allowlist;
      Object.assign(list[idx], patch);
      return next;
    });
  };

  // Damerau-Levenshtein-ish similarity (0..1)
  const similarity = (a, b) => {
    a = (a || '').toLowerCase(); b = (b || '').toLowerCase();
    if (!a || !b) return 0;
    if (a === b) return 1;
    const al = a.length, bl = b.length;
    if (Math.abs(al - bl) > Math.max(al, bl) * 0.5) return 0;
    const dp = Array.from({ length: al + 1 }, () => new Array(bl + 1).fill(0));
    for (let i = 0; i <= al; i++) dp[i][0] = i;
    for (let j = 0; j <= bl; j++) dp[0][j] = j;
    for (let i = 1; i <= al; i++) for (let j = 1; j <= bl; j++) {
      const c = a[i-1] === b[j-1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+c);
    }
    return 1 - dp[al][bl] / Math.max(al, bl);
  };

  const fetchJinaText = async (url) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LOOKUP_TIMEOUT_MS);
    try {
      const res = await fetch('https://r.jina.ai/' + url, {
        headers: { 'Accept': 'text/plain' },
        signal: ctrl.signal,
      });
      if (res.status === 429) throw new Error('rate-limited');
      if (!res.ok) throw new Error('proxy ' + res.status);
      return await res.text();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('timeout');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  const storeUrlFor = (store, id) =>
    store === 'chrome'
      ? `https://chromewebstore.google.com/detail/${id}`
      : `https://microsoftedge.microsoft.com/addons/detail/${id}`;

  const parseStoreText = (text, store) => {
    const titleCandidates = [
      text.match(/Title:\s*([^\n]+)/)?.[1],
      text.match(/^#\s+(.+)$/m)?.[1],
      text.match(/^\s*-\s*([^\n]+?)\s*-\s*Chrome Web Store\s*$/mi)?.[1],
      text.match(/^\s*-\s*([^\n]+?)\s*-\s*Microsoft Edge Addons?\s*$/mi)?.[1],
      text.match(/<title>(.*?)<\/title>/i)?.[1],
    ].filter(Boolean);
    let name = (titleCandidates[0] || '')
      .replace(/\s*-\s*Chrome Web Store\s*$/i, '')
      .replace(/\s*-\s*Microsoft Edge Addons?\s*$/i, '')
      .replace(/^\s*chrome web store\s*[-:]\s*/i, '')
      .trim();
    if (!name || /not found|unavailable|error|404/i.test(name)) return null;

    const imgs = [...text.matchAll(/!\[Image \d+:\s*([^\]]*)\]\((https?:\/\/[^)]+)\)/g)]
      .map(m => ({ alt: (m[1] || '').trim(), url: m[2] }));
    let iconUrl = '';
    if (store === 'chrome') {
      iconUrl = imgs.find(i => /^Item logo image/i.test(i.alt))?.url || '';
    } else {
      const lname = name.toLowerCase();
      iconUrl = imgs.find(i => i.alt.toLowerCase() === lname && !/microsoftLogo/i.test(i.url))?.url
        || imgs.find(i => /store-images\.s-microsoft\.com/.test(i.url) && /mode=scale/.test(i.url))?.url
        || '';
    }
    return { name, iconUrl };
  };

  // Lookup extension info by scraping store pages via r.jina.ai (CORS-friendly text proxy)
  const lookupExtension = async ({ chromeId, edgeId }) => {
    const isChrome = !!chromeId;
    const store = isChrome ? 'chrome' : 'edge';
    const url = isChrome
      ? `https://chromewebstore.google.com/detail/${chromeId}`
      : `https://microsoftedge.microsoft.com/addons/detail/${edgeId}`;
    const info = parseStoreText(await fetchJinaText(url), store);
    if (!info) return null;
    return { ...info };
  };
  // expose for AddRow
  if (typeof window !== 'undefined') window.lookupExtension = lookupExtension;

  const identifyAllUnknown = async (mergeThreshold = MERGE_SIMILARITY_THRESHOLD) => {
    const canIdentify = true;
    const listKey = isBlock ? 'blocklist' : 'allowlist';
    const list = isBlock ? data.blocklist : data.allowlist;
    const targets = list
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.chromeId || e.edgeId);
    if (targets.length === 0) {
      toasts.push('Nothing to identify', 'ok');
      return;
    }
    const myToken = ++identifyToken.current;
    const isCancelled = () => identifyToken.current !== myToken;
    setIdentifying(true);
    setIdentifyProgress({ done: 0, total: targets.length });
    let rateLimitHit = false;
    let identifiedCount = 0, renamedCount = 0;

    if (canIdentify) {
      for (let k = 0; k < targets.length; k++) {
        if (isCancelled()) return;
        const { e, i } = targets[k];
        try {
          const info = await lookupExtension({ chromeId: e.chromeId, edgeId: e.edgeId });
          if (info && isCancelled() === false) {
            const wasRenamed = e.name && e.name !== 'Unknown' && e.name !== info.name;
            if (info.name && wasRenamed) renamedCount++;
            identifiedCount++;
            // Update this single entry immediately — UI refreshes in real time
            setData(d => {
              const next = structuredClone(d);
              const item = next[listKey][i];
              if (item) {
                if (info.name) item.name = info.name;
                if (info.iconUrl) item.iconUrl = info.iconUrl;
              }
              return next;
            });
          }
        } catch (err) {
          if (err.message === 'rate-limited') rateLimitHit = true;
        }
        if (isCancelled()) return;
        setIdentifyProgress({ done: k + 1, total: targets.length });
      }
    }

    if (isCancelled()) return;

    // Merge pass — exact duplicates + fuzzy proposals (runs on final state)
    const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let computedProposals = [];
    setData(d => {
      const next = structuredClone(d);
      const mergedList = next[listKey];

      const nameMap = new Map();
      for (let i = 0; i < mergedList.length; i++) {
        const it = mergedList[i];
        if (!it.name || it.name === 'Unknown') continue;
        const key = norm(it.name);
        if (key && !nameMap.has(key)) nameMap.set(key, i);
      }

      const toRemove = new Set();
      for (let i = 0; i < mergedList.length; i++) {
        if (toRemove.has(i)) continue;
        const it = mergedList[i];
        if (!it.name || it.name === 'Unknown') continue;
        const firstIdx = nameMap.get(norm(it.name));
        if (firstIdx === undefined || firstIdx === i) continue;
        const target = mergedList[firstIdx];
        const fits =
          (target.chromeId && !target.edgeId && !it.chromeId && it.edgeId) ||
          (!target.chromeId && target.edgeId && it.chromeId && !it.edgeId);
        if (!fits) continue;
        if (it.chromeId && !target.chromeId) target.chromeId = it.chromeId;
        if (it.edgeId   && !target.edgeId)   target.edgeId   = it.edgeId;
        if (it.iconUrl   && !target.iconUrl)  target.iconUrl  = it.iconUrl;
        if (it.chromeUrl && !target.chromeUrl) target.chromeUrl = it.chromeUrl;
        if (it.edgeUrl   && !target.edgeUrl)   target.edgeUrl   = it.edgeUrl;
        if (!isBlock && it.mode === 'force_installed') target.mode = 'force_installed';
        toRemove.add(i);
      }

      if (toRemove.size > 0) {
        next[listKey] = mergedList.filter((_, i) => !toRemove.has(i));
      }

      const finalList = next[listKey];
      const proposals = [];
      const seen = new Set();
      for (let a = 0; a < finalList.length; a++) {
        const A = finalList[a];
        if (!A.name || A.name === 'Unknown') continue;
        for (let b = a + 1; b < finalList.length; b++) {
          const B = finalList[b];
          if (!B.name || B.name === 'Unknown') continue;
          if (norm(A.name) === norm(B.name)) continue;
          const fits =
            (A.chromeId && !A.edgeId && !B.chromeId && B.edgeId) ||
            (!A.chromeId && A.edgeId && B.chromeId && !B.edgeId);
          if (!fits) continue;
          const score = similarity(A.name, B.name);
          if (score >= mergeThreshold) {
            const key = `${a}-${b}`;
            if (!seen.has(key)) {
              seen.add(key);
              proposals.push({ a, b, score, nameA: A.name, nameB: B.name });
            }
          }
        }
      }
      computedProposals = proposals;
      return next;
    });
    setMergeProposals(computedProposals);
    setIdentifying(false);

    const parts = [];
    if (identifiedCount) parts.push(`identified ${identifiedCount}`);
    if (renamedCount) parts.push(`renamed ${renamedCount}`);
    parts.push(`scanned ${targets.length}`);
    if (rateLimitHit) parts.push('rate-limited');
    toasts.push(parts.join(' · '), identifiedCount ? 'ok' : 'warn');
  };

  // ============== Import old configs ==============
  const [importTrigger, setImportTrigger] = useState(0);

  const handleImport = (chromeEntries, edgeEntries) => {
    const newList = [];
    for (const e of chromeEntries) {
      const m = e.mode === 'removed' ? (isBlock ? undefined : 'allowed') : e.mode;
      newList.push({
        name: 'Unknown', chromeId: e.id, edgeId: '',
        ...(!isBlock && { mode: m || 'allowed' }),
      });
    }
    for (const e of edgeEntries) {
      const m = e.mode === 'removed' ? (isBlock ? undefined : 'allowed') : e.mode;
      newList.push({
        name: 'Unknown', chromeId: '', edgeId: e.id,
        ...(!isBlock && { mode: m || 'allowed' }),
      });
    }
    setData(d => {
      const next = structuredClone(d);
      if (isBlock) next.blocklist = newList;
      else next.allowlist = newList;
      return next;
    });
    setTab('list');
    toasts.push(`Imported ${chromeEntries.length + edgeEntries.length} entries — identifying…`, 'ok');
    // Trigger auto-identify + merge at 30% threshold in next render (when data is fresh)
    setImportTrigger(t => t + 1);
  };

  const handleImportAllow = (chromeEntries, edgeEntries) => {
    let added = 0;
    setData(d => {
      const next = structuredClone(d);
      const existingChrome = new Set(next.allowlist.map(e => e.chromeId).filter(Boolean));
      const existingEdge   = new Set(next.allowlist.map(e => e.edgeId).filter(Boolean));
      for (const e of chromeEntries) {
        if (!existingChrome.has(e.id)) {
          const m = e.mode === 'removed' ? 'allowed' : (e.mode || 'allowed');
          next.allowlist.push({ name: 'Unknown', chromeId: e.id, edgeId: '', mode: m });
          added++;
        }
      }
      for (const e of edgeEntries) {
        if (!existingEdge.has(e.id)) {
          const m = e.mode === 'removed' ? 'allowed' : (e.mode || 'allowed');
          next.allowlist.push({ name: 'Unknown', chromeId: '', edgeId: e.id, mode: m });
          added++;
        }
      }
      return next;
    });
    setSection('allowlist');
    setTab('list');
    toasts.push(`Added ${added} new entries to allowlist — identifying…`, 'ok');
    setImportTrigger(t => t + 1);
  };

  const handleImportBlock = (chromeEntries, edgeEntries) => {
    let added = 0;
    setData(d => {
      const next = structuredClone(d);
      const existingChrome = new Set(next.blocklist.map(e => e.chromeId).filter(Boolean));
      const existingEdge   = new Set(next.blocklist.map(e => e.edgeId).filter(Boolean));
      for (const e of chromeEntries) {
        if (!existingChrome.has(e.id)) { next.blocklist.push({ name: 'Unknown', chromeId: e.id, edgeId: '' }); added++; }
      }
      for (const e of edgeEntries) {
        if (!existingEdge.has(e.id)) { next.blocklist.push({ name: 'Unknown', chromeId: '', edgeId: e.id }); added++; }
      }
      return next;
    });
    setSection('blocklist');
    setTab('list');
    toasts.push(`Added ${added} new entries to blocklist — identifying…`, 'ok');
    setImportTrigger(t => t + 1);
  };

  // Auto-identify after import (runs after state update / re-render)
  useEffect(() => {
    if (importTrigger > 0) {
      identifyAllUnknown(IMPORT_MERGE_SIMILARITY_THRESHOLD);
    }
  }, [importTrigger]);

  const acceptMerge = (proposal, keepIdx) => {
    setData(d => {
      const next = structuredClone(d);
      const list = isBlock ? next.blocklist : next.allowlist;
      const dropIdx = keepIdx === proposal.a ? proposal.b : proposal.a;
      const target = list[keepIdx];
      const drop = list[dropIdx];
      if (drop.chromeId && !target.chromeId) target.chromeId = drop.chromeId;
      if (drop.edgeId   && !target.edgeId)   target.edgeId   = drop.edgeId;
      if (drop.chromeUrl && !target.chromeUrl) target.chromeUrl = drop.chromeUrl;
      if (drop.edgeUrl   && !target.edgeUrl)   target.edgeUrl   = drop.edgeUrl;
      if (drop.iconUrl   && !target.iconUrl)   target.iconUrl   = drop.iconUrl;
      if (!isBlock && drop.mode === 'force_installed') target.mode = 'force_installed';
      const filtered = list.filter((_, i) => i !== dropIdx);
      if (isBlock) next.blocklist = filtered;
      else next.allowlist = filtered;
      return next;
    });
    setMergeProposals([]);
    toasts.push('Merged', 'ok');
  };

  const dismissMerge = (proposal) => {
    setMergeProposals(p => p.filter(x => x !== proposal));
  };

  const addItem = ({ name, chromeId, edgeId, mode, chromeUrl, edgeUrl, iconUrl }) => {
    const ch = (chromeId || '').trim().toLowerCase();
    const ed = (edgeId   || '').trim().toLowerCase();
    if (!ch && !ed) {
      toasts.push('Provide at least one extension ID', 'err');
      return false;
    }
    if (!isValidId(ch) || !isValidId(ed)) {
      toasts.push('Invalid extension ID — must be 32 lowercase a–p characters', 'err');
      return false;
    }
    // block cross-list duplicates
    const otherList = isBlock ? data.allowlist : data.blocklist;
    const crossConflict = otherList.find(e =>
      (ch && (e.chromeId === ch || e.edgeId === ch)) ||
      (ed && (e.chromeId === ed || e.edgeId === ed))
    );
    if (crossConflict) {
      const other = isBlock ? 'allowlist' : 'blocklist';
      toasts.push(`"${crossConflict.name || 'This extension'}" is already in the ${other}`, 'err');
      return false;
    }
    // find an existing record that overlaps by either ID
    const existingIdx = items.findIndex(e =>
      (ch && (e.chromeId === ch || e.edgeId === ch)) ||
      (ed && (e.chromeId === ed || e.edgeId === ed))
    );
    const cleanName = (name || '').trim();

    setData(d => {
      const next = structuredClone(d);
      const list = isBlock ? next.blocklist : next.allowlist;
      if (existingIdx >= 0) {
        const cur = list[existingIdx];
        if (ch && !cur.chromeId) cur.chromeId = ch;
        if (ed && !cur.edgeId)   cur.edgeId   = ed;
        if (chromeUrl) cur.chromeUrl = chromeUrl;
        if (edgeUrl)   cur.edgeUrl   = edgeUrl;
        if (iconUrl && !cur.iconUrl) cur.iconUrl = iconUrl;
        if (cleanName && (cur.name === 'Unknown' || !cur.name || cur.name.trim() === '')) {
          cur.name = cleanName;
        }
        if (!isBlock && mode) cur.mode = mode;
      } else {
        const entry = {
          name: cleanName || 'Unknown',
          chromeId: ch,
          edgeId: ed,
        };
        if (chromeUrl) entry.chromeUrl = chromeUrl;
        if (edgeUrl)   entry.edgeUrl   = edgeUrl;
        if (iconUrl)   entry.iconUrl   = iconUrl;
        if (!isBlock) entry.mode = mode || 'allowed';
        list.push(entry);
      }
      return next;
    });
    toasts.push(existingIdx >= 0 ? 'Existing entry updated' : 'Added to list', 'ok');
    return true;
  };

  const stats = useMemo(() => {
    if (isBlock) {
      const both = items.filter(e => e.chromeId && e.edgeId).length;
      const chOnly = items.filter(e => e.chromeId && !e.edgeId).length;
      const edOnly = items.filter(e => !e.chromeId && e.edgeId).length;
      const unknown = items.filter(e => e.name === 'Unknown' || !e.name?.trim()).length;
      return [
        { label: 'Total',        value: items.length },
        { label: 'Both',         value: both },
        { label: 'Chrome only',  value: chOnly },
        { label: 'Edge only',    value: edOnly },
        { label: 'Unidentified', value: unknown },
      ];
    }
    const force = items.filter(e => e.mode === 'force_installed').length;
    const both  = items.filter(e => e.chromeId && e.edgeId).length;
    const unknown = items.filter(e => e.name === 'Unknown').length;
    return [
      { label: 'Total',        value: items.length },
      { label: 'On both',      value: both },
      { label: 'Force install',value: force },
      { label: 'Unidentified', value: unknown },
    ];
  }, [items, isBlock]);

  const sectionMeta = {
    allowlist: { title: 'Allowlist', sub: 'Approved extensions across Chrome and Edge' },
    blocklist: { title: 'Blocklist', sub: 'Forcibly removed across Chrome and Edge' },
  }[section];

  const handleExport = () => {
    exportDataAsFile(data);
    toasts.push('Data exported as JSON', 'ok');
  };

  const handleLoadConfirm = (text) => {
    const imported = parseImportText(text);
    if (imported) {
      setData(imported);
      toasts.push(`Imported ${imported.allowlist.length} allow + ${imported.blocklist.length} block entries`, 'ok');
    } else {
      toasts.push('Invalid JSON — expected { "allowlist": [...], "blocklist": [...] }', 'err');
    }
  };

  return (
    <ToastContext.Provider value={toasts}>
      <div className="app">
        <Sidebar
          section={section} setSection={setSection} counts={counts}
          tab={tab} setTab={setTab}
          settingsHasLock={settingsHasLock}
          settingsUnlocked={settingsUnlocked}
          lockProgress={lockProgress}
          onLockToggle={() => { window.EPM_API?.clearUnlockToken(); setSettingsUnlocked(false); }}
          onRequestUnlock={() => setUnlockModal({
            title: 'Unlock settings',
            description: 'Enter the settings password to unlock.',
            confirmLabel: 'Unlock',
            onConfirm: () => { setSettingsUnlocked(true); setUnlockModal(null); },
          })}
          hideBlocklist={hideBlocklist}
          darkMode={darkMode}
          onToggleDark={toggleDark}
        />

        <main className="main" ref={mainRef}>
          {tab === 'settings' ? (
            <>
              <header className="header">
                <div className="header__top">
                  <div>
                    <h1 className="header__title">Settings</h1>
                    <div className="header__sub">Intune connection, policy mapping &amp; data</div>
                  </div>
                </div>
                <div className="header__actions">
                  {settingsHasLock && settingsUnlocked && lockIn && (
                    <span className="header__lock-countdown">{lockIn}</span>
                  )}
                  {settingsHasLock && settingsUnlocked && (
                    <button
                      className="btn btn--sm header__lock-btn"
                      onClick={() => { window.EPM_API?.clearUnlockToken(); setSettingsUnlocked(false); }}
                    >
                      <Icon.Lock /> Lock
                    </button>
                  )}
                </div>
              </header>
              {(!settingsHasLock || settingsUnlocked) && (
                <div className="tabbar">
                  <div className="tabs">
                    <Tab active={settingsTab === 'intune'}   onClick={() => setSettingsTab('intune')}>Intune Connection</Tab>
                    <Tab active={settingsTab === 'mapping'}  onClick={() => setSettingsTab('mapping')}>Policy Mapping</Tab>
                    <Tab active={settingsTab === 'data'}     onClick={() => setSettingsTab('data')}>Data</Tab>
                    <Tab active={settingsTab === 'security'} onClick={() => setSettingsTab('security')}>Security</Tab>
                    <Tab active={settingsTab === 'history'}  onClick={() => setSettingsTab('history')}><Icon.History /> History</Tab>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <Header meta={sectionMeta} stats={stats} isBlock={isBlock} onIdentifyAll={identifyAllUnknown} identifying={identifying} identifyProgress={identifyProgress} />
              {mergeProposals.length > 0 && (
                <MergeProposals
                  proposals={mergeProposals}
                  list={items}
                  onAccept={acceptMerge}
                  onDismiss={dismissMerge}
                />
              )}
              <div className="tabbar">
                <div className="tabs">
                  <Tab active={tab==='list'}   onClick={() => setTab('list')}>
                    <Icon.Filter /> Extensions
                    <span className="tabs__count">{filtered.length}</span>
                  </Tab>
                  <Tab active={tab==='output'} onClick={() => setTab('output')}>
                    <Icon.Code /> Policy output
                  </Tab>
                </div>
                <button
                  className={`btn btn--accent btn--sm tabbar__deploy${deployOpen ? ' tabbar__deploy--open' : ''}`}
                  onClick={() => {
                    if (!deployOpen) mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
                    setDeployOpen(o => !o);
                  }}
                >
                  <Icon.Cloud /> Deploy to Intune
                </button>
              </div>
            </>
          )}

          {deployOpen && tab !== 'settings' && (
            <DeployPanel
              isBlock={isBlock}
              data={data}
              onClose={() => setDeployOpen(false)}
              onDeployed={handleDeployed}
              scrollToTop={() => mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
            />
          )}

          {tab === 'list' && (
            <ListView
              items={filtered}
              total={items.length}
              isBlock={isBlock}
              search={search} setSearch={setSearch}
              filter={filter} setFilter={setFilter}
              keyOf={keyOf}
              editingKey={editingKey}
              setEditingKey={setEditingKey}
              onRemove={(idx) => removeAt(items.indexOf(filtered[idx]))}
              onUpdate={(idx, patch) => updateAt(items.indexOf(filtered[idx]), patch)}
              onAdd={addItem}
              onIdentifyAll={identifyAllUnknown}
              identifying={identifying}
              identifyProgress={identifyProgress}
              settingsUnlocked={settingsUnlocked}
              settingsLocked={settingsHasLock && !settingsUnlocked}
            />
          )}

          {tab === 'output' && (
            <OutputView isBlock={isBlock} data={data} />
          )}

          {tab === 'settings' && (
            settingsHasLock && !settingsUnlocked
              ? <SettingsLockGate onUnlock={async (unlockToken) => {
                  window.EPM_API?.setUnlockToken(unlockToken);
                  await window.INTUNE.loadSettings();
                  setSettingsUnlocked(true);
                }} />
              : <SettingsView
                  onImportAllow={handleImportAllow}
                  onImportBlock={handleImportBlock}
                  onExport={handleExport}
                  onLoadConfirm={handleLoadConfirm}
                  onLockChange={setSettingsHasLock}
                  settingsHasLock={settingsHasLock}
                  hideBlocklist={hideBlocklist}
                  onHideBlocklistChange={(v) => { setHideBlocklist(v); localStorage.setItem('epm_hide_blocklist', v ? '1' : '0'); }}
                  allowDeleteDeployed={allowDeleteDeployed}
                  onAllowDeleteDeployedChange={(v) => { setAllowDeleteDeployed(v); localStorage.setItem('epm_allow_delete_deployed', v ? '1' : '0'); }}
                  settingsTab={settingsTab}
                  autoLockMs={autoLockMs}
                  onAutoLockMsChange={(v) => { setAutoLockMs(v); localStorage.setItem('epm_auto_lock_ms', String(v)); window.INTUNE.setSettings({ autoLockMs: v }).catch(() => {}); }}
                />
          )}
        </main>

        {confirmModal && (
          <ConfirmModal
            title={confirmModal.title}
            description={confirmModal.description}
            confirmLabel={confirmModal.confirmLabel}
            onConfirm={confirmModal.onConfirm}
            onCancel={() => setConfirmModal(null)}
          />
        )}
        {unlockModal && (
          <UnlockModal
            title={unlockModal.title}
            description={unlockModal.description}
            confirmLabel={unlockModal.confirmLabel}
            onConfirm={unlockModal.onConfirm}
            onCancel={() => setUnlockModal(null)}
          />
        )}
        <ToastHost toasts={toasts.toasts} dismiss={toasts.dismiss} />
      </div>
    </ToastContext.Provider>
  );
}

// ============== Lock ring ==============
function LockRing({ progress }) {
  const r = 11;
  const circ = 2 * Math.PI * r;
  return (
    <svg className="lock-ring" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor"
        strokeWidth="1.6" strokeLinecap="round"
        strokeDasharray={circ} strokeDashoffset={-circ * progress}
        transform="rotate(-90 12 12)"
      />
    </svg>
  );
}

// ============== Sidebar ==============
function Sidebar({ section, setSection, counts, tab, setTab, settingsHasLock, settingsUnlocked, lockProgress, onLockToggle, onRequestUnlock, hideBlocklist, darkMode, onToggleDark }) {
  const items = [
    { key: 'allowlist', icon: <Icon.Shield/>, title: 'Allowlist', sub: 'Approved',  count: counts.allowlist },
    ...(!hideBlocklist ? [{ key: 'blocklist', icon: <Icon.Ban/>, title: 'Blocklist', sub: 'Removed', count: counts.blocklist }] : []),
  ];
  return (
    <aside className="sidebar">
      <div className="sidebar__brand" onClick={() => { setSection('allowlist'); setTab('list'); }} style={{cursor:'pointer'}}>
        <div className="sidebar__mark">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M12 2 3 6v6c0 5 4 9 9 10 5-1 9-5 9-10V6Z" stroke="currentColor" strokeWidth="1.6" fill="var(--accent-soft)"/>
            <path d="m8 12 3 3 5-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
          </svg>
        </div>
        <div className="sidebar__title">
          <div className="sidebar__name">Policy Manager</div>
          <div className="sidebar__org">Extension governance</div>
        </div>
        <button
          className={`sidebar__theme-toggle${darkMode ? ' sidebar__theme-toggle--dark' : ''}`}
          onClick={onToggleDark}
          title={darkMode ? 'Dark → Light' : 'Light → Dark'}
          aria-pressed={darkMode}
        >
          <span className="toggle-icon toggle-icon--sun"><Icon.Sun /></span>
          <span className="toggle-knob" />
          <span className="toggle-icon toggle-icon--moon"><Icon.Moon /></span>
        </button>
      </div>

      <div className="sidebar__section-label">Lists</div>
      <nav className="sidebar__nav">
        {items.map(it => (
          <button
            key={it.key}
            className={`nav ${tab !== 'settings' && section === it.key ? 'nav--active' : ''}`}
            onClick={() => { setSection(it.key); setTab('list'); }}
          >
            <span className="nav__icon">{it.icon}</span>
            <span className="nav__body">
              <span className="nav__title">{it.title}</span>
              <span className="nav__sub">{it.sub}</span>
            </span>
            <span className="nav__count">{it.count}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar__section-label">Browsers</div>
      <div className="targets">
        <div className="target"><Icon.Chrome /> <span>Google Chrome</span></div>
        <div className="target"><Icon.Edge /> <span>Microsoft Edge</span></div>
      </div>
      <div className="sidebar__section-label">Targets</div>
      <div className="targets">
        <div className="target"><Icon.Win /> <span>Windows · Intune / GPO</span></div>
        <div className="target"><Icon.Apple /> <span>macOS · MDM profile</span></div>
      </div>

      <div className="sidebar__foot">
        <button
          className={`nav ${tab === 'settings' ? 'nav--active' : ''}`}
          onClick={() => setTab('settings')}
        >
          <span className="nav__icon"><Icon.Sliders /></span>
          <span className="nav__body">
            <span className="nav__title">Settings</span>
            <span className="nav__sub">Intune, data & import</span>
          </span>
          {settingsHasLock && (
            <span
              className={`nav__lock-btn ${settingsUnlocked ? 'nav__lock-btn--unlocked' : 'nav__lock-btn--locked'}`}
              title={settingsUnlocked ? 'Lock settings' : 'Unlock settings'}
              onClick={settingsUnlocked
                ? (e) => { e.stopPropagation(); onLockToggle(); }
                : (e) => { e.stopPropagation(); onRequestUnlock(); }
              }
            >
              {settingsUnlocked && lockProgress > 0 && <LockRing progress={lockProgress} />}
              {settingsUnlocked ? <Icon.Unlock /> : <Icon.Lock />}
            </span>
          )}
        </button>
      </div>
    </aside>
  );
}

// ============== Merge Proposals ==============
function MergeProposals({ proposals, list, onAccept, onDismiss }) {
  return (
    <div className="proposals">
      <div className="proposals__head">
        <Icon.Sparkle />
        <strong>Possible duplicates</strong>
        <span className="proposals__hint">{proposals.length} pair{proposals.length === 1 ? '' : 's'} with similar names — pick the correct name to merge, or dismiss</span>
      </div>
      <ul className="proposals__list">
        {proposals.map((p, idx) => {
          const A = list[p.a]; const B = list[p.b];
          if (!A || !B) return null;
          return (
            <li key={idx} className="proposal">
              <div className="proposal__pair">
                <button
                  type="button"
                  className="proposal__side"
                  onClick={() => onAccept(p, p.a)}
                  title="Keep this name and merge in the other's IDs"
                >
                  <ExtAvatar entry={A} />
                  <div>
                    <div className="proposal__name">{A.name}</div>
                    <div className="proposal__ids">{A.chromeId ? 'Chrome only' : 'Edge only'}</div>
                  </div>
                </button>
                <span className="proposal__op">↔ {Math.round(p.score * 100)}%</span>
                <button
                  type="button"
                  className="proposal__side"
                  onClick={() => onAccept(p, p.b)}
                  title="Keep this name and merge in the other's IDs"
                >
                  <ExtAvatar entry={B} />
                  <div>
                    <div className="proposal__name">{B.name}</div>
                    <div className="proposal__ids">{B.chromeId ? 'Chrome only' : 'Edge only'}</div>
                  </div>
                </button>
              </div>
              <button
                type="button"
                className="proposal__dismiss"
                onClick={() => onDismiss(p)}
                title="Not the same extension"
              ><Icon.X /></button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ============== Header ==============
function Header({ meta, stats, isBlock, onIdentifyAll, identifying, identifyProgress }) {
  const unknownCount = stats.find(s => s.label === 'Unidentified')?.value || 0;
  return (
    <header className="header">
      <div className="header__top">
        <div>
          <h1 className="header__title">{meta.title}</h1>
          <div className="header__sub">{meta.sub}</div>
        </div>
        <div className="header__stats">
          {stats.map((s, i) => (
            <div key={i} className="stat">
              <div className="stat__value">{s.value}</div>
              <div className="stat__label">{s.label}</div>
            </div>
          ))}
        </div>
      </div>
      {(
        <div className="header__actions">
          {identifying && (
            <span className="header__identify-progress">
              <Icon.Spinner /> {identifyProgress.done}/{identifyProgress.total}
            </span>
          )}
          {unknownCount > 0 && !identifying && (
            <button
              className="btn btn--primary btn--sm"
              onClick={onIdentifyAll}
              title="Resolve every Unknown entry through AI catalog lookup"
            >
              <Icon.Sparkle />
              {`Identify ${unknownCount} unknown`}
            </button>
          )}
        </div>
      )}
    </header>
  );
}

function Tab({ active, onClick, children }) {
  return <button className={`tab ${active?'tab--active':''}`} onClick={onClick}>{children}</button>;
}

// ============== List view ==============
const MODE_ORDER = { force_installed: 0, normal_installed: 1, allowed: 2, removed: 3 };

function ListView({ items, total, isBlock, search, setSearch, filter, setFilter, keyOf, editingKey, setEditingKey, onRemove, onUpdate, onAdd, onIdentifyAll, identifying, identifyProgress, settingsUnlocked, settingsLocked }) {
  const searchRef = useRef(null);
  const viewRef   = useRef(null);
  const [sort, setSort] = useState('default');
  const [showScrollTop, setShowScrollTop] = useState(false);

  useEffect(() => {
    const scroller = viewRef.current?.closest('.main');
    if (!scroller) return;
    const onScroll = () => setShowScrollTop(scroller.scrollTop > 300);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, []);

  const sortedItems = useMemo(() => {
    if (sort === 'default') return items;
    const arr = [...items];
    if (sort === 'alpha') return arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (sort === 'mode')  return arr.sort((a, b) => (MODE_ORDER[a.mode] ?? 99) - (MODE_ORDER[b.mode] ?? 99));
    return arr;
  }, [items, sort]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey||e.ctrlKey) && e.key === 'k') { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="view" ref={viewRef}>
      <div className="view__sticky-top">
        <AddRow isBlock={isBlock} onAdd={onAdd} onIdentifyAll={onIdentifyAll} identifying={identifying} settingsLocked={settingsLocked} />
        <div className="toolbar">
        <div className="searchwrap">
          <Icon.Search />
          <input
            ref={searchRef}
            className="search"
            placeholder="Search by name or ID…"
            aria-label="Search extensions by name or ID"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && <button className="search__clear" onClick={()=>setSearch('')}><Icon.X /></button>}
        </div>

        <div className="segmented">
          <SegBtn active={filter==='all'}         onClick={()=>setFilter('all')}>All</SegBtn>
          <SegBtn active={filter==='both'}        onClick={()=>setFilter('both')}>Both</SegBtn>
          <SegBtn active={filter==='chrome-only'} onClick={()=>setFilter('chrome-only')}>Chrome</SegBtn>
          <SegBtn active={filter==='edge-only'}   onClick={()=>setFilter('edge-only')}>Edge</SegBtn>
          {!isBlock && <SegBtn active={filter==='force'}   onClick={()=>setFilter('force')}>Forced</SegBtn>}
          <SegBtn active={filter==='unknown'}     onClick={()=>setFilter('unknown')}>Unidentified</SegBtn>
        </div>

        <div className="toolbar__sort">
          <SegBtn active={sort==='default'} onClick={()=>setSort('default')}>Default</SegBtn>
          <SegBtn active={sort==='alpha'}   onClick={()=>setSort('alpha')}>A→Z</SegBtn>
          {!isBlock && <SegBtn active={sort==='mode'} onClick={()=>setSort('mode')}>Mode</SegBtn>}
        </div>

        <div className="toolbar__count">{items.length} of {total}</div>
      </div>
      </div>

      {sortedItems.length === 0 ? (
        <EmptyState query={search} />
      ) : (
        <ul className="list">
          {sortedItems.map((e) => {
            const k = keyOf(e);
            const originalIdx = items.indexOf(e);
            return (
              <ListRow
                key={k}
                item={e}
                isBlock={isBlock}
                isEditing={editingKey === k}
                onStartEdit={() => setEditingKey(k)}
                onStopEdit={() => setEditingKey(null)}
                onRemove={() => onRemove(originalIdx)}
                onUpdate={(patch) => onUpdate(originalIdx, patch)}
                settingsUnlocked={settingsUnlocked}
              />
            );
          })}
        </ul>
      )}

      <button
        className={`scroll-top-btn${showScrollTop ? ' scroll-top-btn--visible' : ''}`}
        onClick={() => viewRef.current?.closest('.main')?.scrollTo({ top: 0, behavior: 'smooth' })}
        title="Back to top"
        aria-hidden={!showScrollTop}
      >
        <Icon.ArrowUp />
      </button>
    </div>
  );
}

function SegBtn({ active, onClick, children }) {
  return <button className={`seg ${active?'seg--active':''}`} onClick={onClick}>{children}</button>;
}

function EmptyState({ query }) {
  return (
    <div className="empty">
      <div className="empty__glyph"><Icon.Search /></div>
      <div className="empty__title">No matches</div>
      <div className="empty__sub">{query ? <>Nothing matches "<b>{query}</b>".</> : 'Try a different filter or add an extension.'}</div>
    </div>
  );
}

// ============== List row ==============
function ListRow({ item, isBlock, isEditing, onStartEdit, onStopEdit, onRemove, onUpdate, settingsUnlocked }) {
  const isUnknown = item.name === 'Unknown' || !item.name;
  const chromeLocked = !!item.deployedAt && !!item.chromeId && !settingsUnlocked;
  const edgeLocked   = !!item.deployedAt && !!item.edgeId   && !settingsUnlocked;
  const [draftName, setDraftName] = useState(isUnknown ? '' : item.name);
  const [draftChrome, setDraftChrome] = useState(item.chromeId || '');
  const [draftEdge, setDraftEdge] = useState(item.edgeId || '');
  const [looking, setLooking] = useState(false);
  const inputRef = useRef(null);
  const toast = React.useContext(ToastContext);

  useEffect(() => {
    if (isEditing) {
      setDraftName(isUnknown ? '' : item.name);
      setDraftChrome(item.chromeId || '');
      setDraftEdge(item.edgeId || '');
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isEditing, item.name, item.chromeId, item.edgeId, isUnknown]);

  const commit = () => {
    const ch = draftChrome.trim().toLowerCase();
    const ed = draftEdge.trim().toLowerCase();
    if (!isValidId(ch) || !isValidId(ed)) {
      toast.push('Invalid extension ID — must be 32 lowercase a–p chars', 'err');
      return;
    }
    if (!ch && !ed) {
      toast.push('At least one ID required', 'err');
      return;
    }
    onUpdate({
      name: draftName.trim() || 'Unknown',
      chromeId: chromeLocked ? item.chromeId : ch,
      edgeId:   edgeLocked   ? item.edgeId   : ed,
    });
    onStopEdit();
  };
  const cancel = () => onStopEdit();

  const lookup = async () => {
    if (looking) return;
    const ch = draftChrome.trim().toLowerCase() || item.chromeId;
    const ed = draftEdge.trim().toLowerCase()   || item.edgeId;
    if (!ch && !ed) {
      toast.push('Enter at least one ID first', 'warn');
      return;
    }
    setLooking(true);
    try {
      const info = await window.lookupExtension({ chromeId: ch, edgeId: ed });
      if (info?.name) {
        setDraftName(info.name);
        toast.push(`Found: ${info.name}`, 'ok');
      } else {
        toast.push('Could not identify extension', 'warn');
      }
    } catch (err) {
      toast.push('Lookup failed', 'err');
    } finally {
      setLooking(false);
    }
  };

  if (isEditing) {
    return (
      <li className="row row--editing">
        <ExtAvatar id={item.chromeId || item.edgeId || 'xx'} name={draftName || item.name} iconUrl={item.iconUrl} />
        <div className="row__edit-grid">
          <div className="row__edit-name">
            <label className="row__edit-label">Display name</label>
            <div className="row__edit-namewrap">
              <input
                ref={inputRef}
                className="row__edit-input"
                value={draftName}
                onChange={e => setDraftName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') cancel(); }}
                placeholder="Extension name"
              />
              {(
                <button
                  className={`btn btn--ghost btn--sm ${looking?'iconbtn--spin':''}`}
                  onClick={lookup}
                  disabled={looking}
                  title="Look up name from store catalog"
                >
                  {looking ? <Icon.Spinner /> : <Icon.Sparkle />}
                  <span>{looking ? 'Searching…' : 'Find name'}</span>
                </button>
              )}
            </div>
          </div>
          <div className="row__edit-ids">
            <IdField
              label="Chrome ID"
              icon={<Icon.Chrome />}
              value={draftChrome}
              onChange={setDraftChrome}
              onCommit={commit}
              onCancel={cancel}
              readOnly={chromeLocked}
            />
            <IdField
              label="Edge ID"
              icon={<Icon.Edge />}
              value={draftEdge}
              onChange={setDraftEdge}
              onCommit={commit}
              onCancel={cancel}
              readOnly={edgeLocked}
            />
          </div>
        </div>
        <div className="row__edit-actions">
          <button className="btn btn--ghost btn--sm" onClick={cancel}>Cancel</button>
          <button className="btn btn--primary btn--sm" onClick={commit}><Icon.Check /> Save</button>
        </div>
      </li>
    );
  }

  return (
    <li className="row">
      <ExtAvatar id={item.chromeId || item.edgeId || 'xx'} name={item.name} iconUrl={item.iconUrl} />
      <div className="row__main">
        <button
          className={`row__name row__name--btn ${isUnknown?'row__name--unknown':''}`}
          onClick={onStartEdit}
          title="Click to edit"
        >
          <span>{isUnknown ? 'Unidentified' : item.name}</span>
          <Icon.Pencil className="row__name-edit-icon" />
        </button>
        <div className="row__ids">
          <IdChip
            kind="chrome"
            icon={<Icon.Chrome />}
            id={item.chromeId}
            hasLink={!!item.chromeUrl}
            url={item.chromeUrl}
            faviconUrl={item.chromeUrl ? `https://www.google.com/s2/favicons?domain=chromewebstore.google.com&sz=32` : null}
          />
          <IdChip
            kind="edge"
            icon={<Icon.Edge />}
            id={item.edgeId}
            hasLink={!!item.edgeUrl}
            url={item.edgeUrl}
            faviconUrl={item.edgeUrl ? `https://www.google.com/s2/favicons?domain=microsoftedge.microsoft.com&sz=32` : null}
          />
        </div>
      </div>

      <div className="row__right">
        {isBlock ? (
          <ModeBadge mode="removed" />
        ) : (
          <ModeSelector mode={item.mode} onChange={(m) => onUpdate({ mode: m })} />
        )}
        {item.deployedAt && <span className="deployed-badge" title={`Deployed ${new Date(item.deployedAt).toLocaleDateString()}`}>deployed</span>}
        <button className="iconbtn iconbtn--danger" onClick={onRemove} aria-label="Remove">
          <Icon.X />
        </button>
      </div>
    </li>
  );
}

function IdChip({ kind, icon, id, url, hasLink, faviconUrl }) {
  if (!id) {
    return (
      <span className={`idchip idchip--empty idchip--${kind}`}>
        {icon}
        <span className="idchip__id">— no ID —</span>
      </span>
    );
  }
  const toast = React.useContext(ToastContext);
  const doCopy = (text) => {
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(fallback);
    } else {
      fallback();
    }
    toast.push('ID copied', 'ok');
  };
  const copyId = (e) => {
    e.preventDefault();
    e.stopPropagation();
    doCopy(id);
  };
  const openLink = (e) => {
    if (e.target.closest('.idchip__copy')) return; // copy button handles itself
    // let the anchor's natural target=_blank do its thing
  };

  const visual = (
    <>
      {faviconUrl ? (
        <img className="idchip__favicon" src={faviconUrl} alt="" onError={(e)=>{e.currentTarget.style.display='none';}} />
      ) : icon}
      <span className="idchip__id">{id}</span>
    </>
  );

  if (hasLink && url) {
    return (
      <span className={`idchip idchip--${kind} idchip--linked`}>
        <a
          className="idchip__link"
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          title={`Open ${id} in new tab`}
        >
          {visual}
        </a>
        <button
          type="button"
          className="idchip__copy"
          onClick={copyId}
          onMouseDown={(e) => e.stopPropagation()}
          title="Copy ID"
        ><Icon.Copy /></button>
      </span>
    );
  }
  // No saved URL — clicking copies the ID
  return (
    <button
      type="button"
      className={`idchip idchip--${kind} idchip--copyonly`}
      onClick={copyId}
      title={`Copy ${id}`}
    >
      {visual}
      <Icon.Copy />
    </button>
  );
}

function IdField({ label, icon, value, onChange, onCommit, onCancel, readOnly }) {
  const valid = !value || ID_REGEX.test(value.trim().toLowerCase());
  return (
    <div className="idfield">
      <label className="row__edit-label">
        <span className="idfield__label-icon">{icon}</span> {label}
      </label>
      <input
        className={`row__edit-input row__edit-input--mono ${value && !valid ? 'row__edit-input--bad' : ''} ${readOnly ? 'row__edit-input--locked' : ''}`}
        value={value}
        onChange={e => { if (!readOnly) onChange(e.target.value); }}
        onKeyDown={e => { if (e.key === 'Enter') onCommit(); if (e.key === 'Escape') onCancel(); }}
        placeholder="32 chars, a–p"
        maxLength={32}
        spellCheck="false"
        readOnly={readOnly}
        title={readOnly ? 'ID locked — already deployed' : undefined}
      />
    </div>
  );
}

function ModeSelector({ mode, onChange }) {
  return (
    <div className="modeswitch">
      <button
        className={`modeswitch__opt ${mode==='allowed'?'modeswitch__opt--on':''}`}
        onClick={()=>onChange('allowed')}
        title="Allowed"
      >
        <span className="badge-dot badge-dot--allowed" />Allowed
      </button>
      <button
        className={`modeswitch__opt ${mode==='force_installed'?'modeswitch__opt--on':''}`}
        onClick={()=>onChange('force_installed')}
        title="Force installed"
      >
        <Icon.Pin /> Forced
      </button>
    </div>
  );
}

// ============== Add row ==============
function AddRow({ isBlock, onAdd, onIdentifyAll, identifying, settingsLocked }) {
  const toast = React.useContext(ToastContext);
  const [smart, setSmart] = useState('');
  const [name, setName] = useState('');
  const [chromeId, setChromeId] = useState('');
  const [edgeId, setEdgeId] = useState('');
  const [mode, setMode] = useState('allowed');
  const [busy, setBusy] = useState(false);
  const [iconUrl, setIconUrl] = useState('');
  // For raw IDs, user chooses which store. URLs override this.
  const [rawStore, setRawStore] = useState('chrome');
  // Remembered store when a URL was pasted (survives the URL→ID replacement).
  const [urlStore, setUrlStore] = useState(null);
  const [secondaryUrlStore, setSecondaryUrlStore] = useState(null);

  // Parse the smart input: detect URL vs raw ID, route to chrome/edge.
  const parseSmart = (raw, rawStoreOverride = rawStore) => {
    const v = (raw || '').trim();
    if (!v) return null;

    // bare 32-char a–p ID
    if (ID_REGEX.test(v.toLowerCase())) {
      const id = v.toLowerCase();
      return rawStoreOverride === 'edge'
        ? { chromeId: '', edgeId: id, source: 'id', detectedStore: null }
        : { chromeId: id, edgeId: '', source: 'id', detectedStore: null };
    }

    // try URL parse
    let url;
    try { url = new URL(v); } catch { return null; }
    const host = url.hostname.toLowerCase();
    const segs = url.pathname.split('/').filter(Boolean);
    // grab last 32-char id-looking segment
    const idSeg = [...segs].reverse().find(s => ID_REGEX.test(s.toLowerCase()));
    if (!idSeg) return null;
    const id = idSeg.toLowerCase();
    if (host.includes('microsoftedge.microsoft.com') || host.includes('edge.microsoft.com')) {
      return { chromeId: '', edgeId: id, source: 'url', detectedStore: 'edge', fullUrl: url.href };
    }
    // default treat as chrome (chromewebstore.google.com / chrome.google.com)
    return { chromeId: id, edgeId: '', source: 'url', detectedStore: 'chrome', fullUrl: url.href };
  };

  // apply parsed result. If switching raw store, clear the OTHER id so we don't keep stale.
  const apply = (parsed, { clearOther = true } = {}) => {
    if (parsed.chromeId) {
      setChromeId(parsed.chromeId);
      if (clearOther) setEdgeId('');
    } else if (parsed.edgeId) {
      setEdgeId(parsed.edgeId);
      if (clearOther) setChromeId('');
    }
  };

  // re-route raw ID when user toggles store
  const onRawStoreChange = (store) => {
    setRawStore(store);
    const parsed = parseSmart(smart, store);
    if (parsed && parsed.source === 'id') apply(parsed);
  };

  // when user pastes/types — auto-fill ID fields & derive name from URL slug
  const onSmartChange = (val) => {
    setUrlStore(null);
    setSmart(val);
    const parsed = parseSmart(val);
    if (!parsed) return;
    apply(parsed);
    // derive name from URL slug — handles encoded chars (% sequences)
    if (parsed.fullUrl) {
      try {
        const u = new URL(parsed.fullUrl);
        const segs = u.pathname.split('/').filter(Boolean);
        const slugSeg = segs.length >= 2 ? segs[segs.length - 2] : null;
        if (slugSeg && slugSeg !== 'detail') {
          let decoded;
          try { decoded = decodeURIComponent(slugSeg); } catch { decoded = slugSeg; }
          // truncated slugs end with "-" or partial-word: drop trailing dash
          decoded = decoded.replace(/-+$/, '');
          // turn dashes into spaces, title-case
          const guess = decoded
            .replace(/-/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/\b\w/g, c => c.toUpperCase());
          if (guess && (!name || name === 'Unknown')) {
            setName(guess);
          }
        }
      } catch {}
      // replace the pasted URL with just the extracted ID, remember detected store
      const extractedId = parsed.chromeId || parsed.edgeId;
      if (extractedId) {
        setSmart(extractedId);
        setUrlStore(parsed.detectedStore);
      }
    }
  };

  // Lookup official name + icon by scraping store page via r.jina.ai
  const lookup = async () => {
    if (!true || typeof window.lookupExtension !== 'function') {
      toast.push('Lookup is disabled in standalone mode', 'warn');
      return;
    }
    const parsed = parseSmart(smart) || (chromeId || edgeId
      ? { chromeId, edgeId, source: 'manual', detectedStore: chromeId ? 'chrome' : 'edge' }
      : null);
    if (!parsed) {
      toast.push('Enter a URL or ID first', 'warn');
      return;
    }
    setBusy(true);
    try {
      const info = await window.lookupExtension({ chromeId: parsed.chromeId, edgeId: parsed.edgeId });
      if (info?.name) {
        setName(info.name);
        if (info.iconUrl) setIconUrl(info.iconUrl);
        toast.push(`Identified: ${info.name}`, 'ok');
      } else {
        toast.push('Could not identify extension', 'warn');
      }
    } catch (err) {
      const msg = err.message === 'timeout' ? 'Lookup timed out'
                : err.message === 'rate-limited' ? 'Rate-limited — try again shortly'
                : 'Lookup failed';
      toast.push(msg, 'err');
    } finally {
      setBusy(false);
    }
  };

  const submit = (e) => {
    e.preventDefault();
    // also accept smart input as final source if user didn't blur
    let lastParsed = parseSmart(smart);
    if (smart && !chromeId && !edgeId && lastParsed) {
      apply(lastParsed);
    }
    // determine which URLs to attach: prefer the one parsed from the smart input
    let chromeUrl, edgeUrl;
    if (lastParsed?.fullUrl) {
      if (lastParsed.detectedStore === 'chrome') chromeUrl = lastParsed.fullUrl;
      if (lastParsed.detectedStore === 'edge')   edgeUrl   = lastParsed.fullUrl;
    }
    const ok = onAdd({
      name: name.trim(),
      chromeId: chromeId.trim(),
      edgeId: edgeId.trim(),
      mode,
      chromeUrl,
      edgeUrl,
      iconUrl: iconUrl.trim() || undefined,
    });
    if (ok) {
      setSmart(''); setName(''); setChromeId(''); setEdgeId(''); setIconUrl('');
      setUrlStore(null); setSecondaryUrlStore(null);
    }
  };

  const parsed = useMemo(() => parseSmart(smart), [smart, rawStore]);
  const canSubmit = (chromeId.trim() || edgeId.trim()) && !busy;
  const detectedStore = urlStore || parsed?.detectedStore;
  const otherIsEdge = detectedStore === 'chrome' || (!detectedStore && rawStore === 'chrome');

  return (
    <form className="addrow" onSubmit={submit}>
      <div className="addrow__header">
        <span className="addrow__header-title">{isBlock ? 'Block extension' : 'Add extension'}</span>
        <span className="addrow__header-hint">
          Paste a Chrome Web Store or Edge Add-ons URL — ID fills automatically. Or enter a 32-char extension ID and choose the store.
        </span>
      </div>
      <div className="addrow__top">
        <div className="addrow__smart">
          <label className="addrow__label">
            <Icon.Link /> Paste URL or ID
          </label>
          <div className="addrow__smartwrap">
            <span className={`addrow__detect ${detectedStore ? `addrow__detect--${detectedStore}` : (parsed?.source === 'id' ? `addrow__detect--${rawStore}` : '')}`}>
              {detectedStore === 'edge' || (parsed?.source === 'id' && rawStore === 'edge')
                ? <img className="addrow__detect-fav" src="https://www.google.com/s2/favicons?domain=microsoftedge.microsoft.com&sz=32" alt="" onError={(e)=>{e.currentTarget.style.display='none';}} />
                : detectedStore === 'chrome' || (parsed?.source === 'id' && rawStore === 'chrome')
                  ? <img className="addrow__detect-fav" src="https://www.google.com/s2/favicons?domain=chromewebstore.google.com&sz=32" alt="" onError={(e)=>{e.currentTarget.style.display='none';}} />
                  : <Icon.Globe />}
            </span>
            <input
              className="addrow__smartinput"
              placeholder="https://chromewebstore.google.com/detail/...  —  or 32-char ID"
              value={smart}
              onChange={e => onSmartChange(e.target.value)}
              spellCheck="false"
            />
            {parsed?.source === 'id' && !urlStore && (
              <div className="addrow__rawstore">
                <button
                  type="button"
                  className={`addrow__rawbtn ${rawStore === 'chrome' ? 'addrow__rawbtn--active' : ''}`}
                  onClick={() => onRawStoreChange('chrome')}
                  title="Treat as Chrome ID"
                ><Icon.Chrome /> Chrome</button>
                <button
                  type="button"
                  className={`addrow__rawbtn ${rawStore === 'edge' ? 'addrow__rawbtn--active' : ''}`}
                  onClick={() => onRawStoreChange('edge')}
                  title="Treat as Edge ID"
                ><Icon.Edge /> Edge</button>
              </div>
            )}
            {smart && (
              <button
                type="button"
                className="addrow__clear"
                onClick={() => { setSmart(''); setUrlStore(null); }}
                title="Clear"
              ><Icon.X /></button>
            )}
          </div>
        </div>

        <div className="addrow__field addrow__field--name">
          <div className="addrow__label addrow__label--row">
            <span>Display name</span>
            <button
              type="button"
              className="btn btn--ghost btn--sm addrow__identify-btn"
              onClick={lookup}
              disabled={busy || (!smart && !chromeId && !edgeId)}
              title="Identify this extension via AI catalog"
            >
              {busy ? <Icon.Spinner /> : <Icon.Sparkle />}
              Auto identify
            </button>
          </div>
          <div className="addrow__namewrap">
            <input
              className="addrow__input"
              placeholder="e.g. Grammarly"
              value={name}
              onChange={e => setName(e.target.value)}
              style={name ? {paddingRight: 32} : {}}
            />
            {name && (
              <button type="button" className="addrow__input-clear" onClick={() => setName('')} title="Clear"><Icon.X /></button>
            )}
          </div>
        </div>

        {!isBlock && (
          <div className="addrow__field addrow__field--mode">
            <label className="addrow__label">Mode</label>
            <div className="addrow__seg">
              <button type="button" className={`seg ${mode==='allowed'?'seg--active':''}`} onClick={()=>setMode('allowed')}>Allow</button>
              <button type="button" className={`seg ${mode==='force_installed'?'seg--active':''}`} onClick={()=>setMode('force_installed')}>Force</button>
            </div>
          </div>
        )}
        <div className="addrow__submit">
          <button type="submit" className="btn btn--primary" disabled={!canSubmit}>
            <Icon.Plus /> Add
          </button>
        </div>

        {parsed && (
          <div className="addrow__secondary">
            <label className="addrow__label">
              {otherIsEdge ? <><Icon.Edge /> Edge ID</> : <><Icon.Chrome /> Chrome ID</>}
              <span className="addrow__secondary-opt">{secondaryUrlStore ? 'detected' : 'optional'}</span>
            </label>
            <div className="addrow__smartwrap">
              <span className={`addrow__detect${secondaryUrlStore ? ` addrow__detect--${secondaryUrlStore}` : ''}`}>
                {secondaryUrlStore === 'edge'
                  ? <img className="addrow__detect-fav" src="https://www.google.com/s2/favicons?domain=microsoftedge.microsoft.com&sz=32" alt="" onError={e => { e.currentTarget.style.display = 'none'; }} />
                  : secondaryUrlStore === 'chrome'
                    ? <img className="addrow__detect-fav" src="https://www.google.com/s2/favicons?domain=chromewebstore.google.com&sz=32" alt="" onError={e => { e.currentTarget.style.display = 'none'; }} />
                    : <Icon.Globe />}
              </span>
              <input
                className={`addrow__smartinput addrow__smartinput--mono${(otherIsEdge ? edgeId : chromeId) && !ID_REGEX.test((otherIsEdge ? edgeId : chromeId).toLowerCase()) ? ' addrow__input--bad' : ''}`}
                placeholder="32-char ID from the other store"
                value={otherIsEdge ? edgeId : chromeId}
                onChange={e => {
                  const v = e.target.value;
                  const secondaryParsed = parseSmart(v);
                  if (secondaryParsed?.source === 'url') {
                    const sameStore = otherIsEdge ? 'chrome' : 'edge';
                    if (secondaryParsed.detectedStore === sameStore) {
                      toast.push(`This is a ${sameStore === 'chrome' ? 'Chrome Web Store' : 'Edge Add-ons'} URL — use the main field`, 'warn');
                      return;
                    }
                  }
                  const id = secondaryParsed ? (secondaryParsed.chromeId || secondaryParsed.edgeId) : v;
                  setSecondaryUrlStore(secondaryParsed?.source === 'url' ? secondaryParsed.detectedStore : null);
                  otherIsEdge ? setEdgeId(id) : setChromeId(id);
                }}
                spellCheck="false"
              />
              {(otherIsEdge ? edgeId : chromeId) && (
                <button type="button" className="addrow__clear" onClick={() => { otherIsEdge ? setEdgeId('') : setChromeId(''); setSecondaryUrlStore(null); }} title="Clear"><Icon.X /></button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="addrow__bottom">
        <div className="addrow__hint">
          {detectedStore === 'chrome' && <span>Detected Chrome Web Store · ID auto-filled</span>}
          {detectedStore === 'edge' && <span>Detected Edge Add-ons · ID auto-filled</span>}
          {parsed?.source === 'id' && !urlStore && <span>Raw ID — choose store on the right</span>}
          {!parsed && smart && <span className="addrow__hint--warn">Not a valid store URL or ID</span>}
          {!smart && <span>Paste full store link to auto-fill ID, store and try to identify name</span>}
        </div>
        <div className="addrow__bottom-actions">
          {!settingsLocked && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={onIdentifyAll}
              disabled={identifying}
              title="Re-scan unknown extensions and merge duplicates by name"
            >
              {identifying ? <Icon.Spinner /> : <Icon.RefreshSparkle />}
              Re-identify all
            </button>
          )}
        </div>
      </div>

    </form>
  );
}

// Legacy deploy script download is intentionally disabled: creating Intune policies is not allowed.
const DEPLOY_SCRIPT = `throw "Use the web deploy flow with explicit existing-policy mapping. Creating Intune policies is disabled."`;


// ============== Output view ==============
function buildFiles(isBlock, data) {
  const G = window.GENERATORS;
  if (isBlock) {
    const winChrome = { filename: 'Windows-Block-Chrome-Extension.json', text: G.genWindowsBlockJSON(data.blocklist, 'chrome') };
    const winEdge   = { filename: 'Windows-Block-Edge-Extension.json',   text: G.genWindowsBlockJSON(data.blocklist, 'edge') };
    return [
      { key: 'win-block-chrome', deployName: 'Browser Extension Policy - Blocklist Chrome',    os: 'windows', title: 'Windows — Block Chrome Extension', subtitle: 'Settings Catalog · Chrome policy',                                     filename: winChrome.filename, mime: 'application/json',                  lang: 'json', text: winChrome.text },
      { key: 'win-block-edge',   deployName: 'Browser Extension Policy - Blocklist Edge',      os: 'windows', title: 'Windows — Block Edge Extension',   subtitle: 'Settings Catalog · Edge policy',                                       filename: winEdge.filename,   mime: 'application/json',                  lang: 'json', text: winEdge.text },
      { key: 'mac-block',        deployName: 'Browser Extension Policy - Blocklist Chrome+Edge', os: 'macos', title: 'macOS — Block Browser Extension',  subtitle: 'Custom configuration profile · combined Chrome + Edge', filename: 'MacOS-Block-Browser-Extension.mobileconfig', mime: 'application/x-apple-aspen-config', lang: 'xml',  text: G.genMacBlockMobileconfig(data.blocklist) },
    ];
  }
  const winChrome = { filename: 'Windows-Allow-Chrome-Extension.json', text: G.genWindowsAllowJSON(data.allowlist, 'chrome') };
  const winEdge   = { filename: 'Windows-Allow-Edge-Extension.json',   text: G.genWindowsAllowJSON(data.allowlist, 'edge') };
  return [
    { key: 'win-allow-chrome', deployName: 'Browser Extension Policy - Allowlist Chrome',    os: 'windows', title: 'Windows — Allow Chrome Extension', subtitle: 'Settings Catalog · Chrome policy',                                     filename: winChrome.filename, mime: 'application/json',                  lang: 'json', text: winChrome.text },
    { key: 'win-allow-edge',   deployName: 'Browser Extension Policy - Allowlist Edge',      os: 'windows', title: 'Windows — Allow Edge Extension',   subtitle: 'Settings Catalog · Edge policy',                                       filename: winEdge.filename,   mime: 'application/json',                  lang: 'json', text: winEdge.text },
    { key: 'mac-allow',        deployName: 'Browser Extension Policy - Allowlist Chrome+Edge', os: 'macos', title: 'macOS — Allow Browser Extension',  subtitle: 'Custom configuration profile · combined Chrome + Edge', filename: 'MacOS-Allow-Browser-Extension.mobileconfig',  mime: 'application/x-apple-aspen-config', lang: 'xml',  text: G.genMacAllowMobileconfig(data.allowlist) },
  ];
}

// ============== Deploy Panel ==============
function parseTickets(input) {
  const tickets = [];
  const seen = new Set();
  const add = (id) => { if (!seen.has(id)) { seen.add(id); tickets.push(id); } };
  // Extract from Atlassian URLs
  const urlRe = /atlassian\.net\/browse\/([A-Z]+-\d+)/g;
  let m;
  while ((m = urlRe.exec(input)) !== null) add(m[1]);
  // Extract standalone IDs (skip already-URL-matched)
  const noUrls = input.replace(/https?:\/\/\S+/g, ' ');
  const idRe = /\b([A-Z]{1,10}-\d+)\b/g;
  while ((m = idRe.exec(noUrls)) !== null) add(m[1]);
  return tickets;
}

function DeployPanel({ isBlock, data, onClose, onDeployed, scrollToTop }) {
  const toast = React.useContext(ToastContext);
  const allConfigs = window.INTUNE.getSettings().configs;
  const [selectedDeployConfig, setSelectedDeployConfig] = useState(allConfigs[0]?.name || '');
  const [deployState, setDeployState] = useState(allConfigs.length > 1 ? 'select-config' : 'loading');
  const [deployProgress, setDeployProgress] = useState('Connecting to Intune…');
  const [deployResults, setDeployResults] = useState([]);
  const [intunePolicies, setIntunePolicies] = useState([]);
  const [policyMap, setPolicyMap] = useState({});
  const [ticketInput, setTicketInput] = useState('');
  const panelRef = React.useRef(null);
  const ticketRef = React.useRef(null);

  const parsedTickets = useMemo(() => parseTickets(ticketInput), [ticketInput]);
  const ticketNote = parsedTickets.length > 0 ? parsedTickets.join(', ') : '';
  const ticketPlaceholder = useMemo(() => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const len = 2 + Math.floor(Math.random() * 3);
    const pfx = Array.from({length: len}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const num = 10000 + Math.floor(Math.random() * 90000);
    return `${pfx}-${num}  or  https://company.atlassian.net/browse/${pfx}-${num}`;
  }, []);

  const files = useMemo(() => buildFiles(isBlock, data), [isBlock, data]);

  useEffect(() => {
    if (allConfigs.length <= 1) startDeploy(allConfigs[0]?.name || '');
  }, []);

  useEffect(() => {
    if (deployState === 'ticket') {
      ticketRef.current?.focus({ preventScroll: true });
    }
  }, [deployState]);

  const startDeploy = async (configName) => {
    setDeployState('loading');
    setDeployProgress('Connecting to Intune…');
    try {
      const conf = allConfigs.find(c => c.name === configName);
      let savedMap = conf?.policyMap || {};
      if (!Object.values(savedMap).some(Boolean)) {
        try {
          const url = configName ? `/api/policy-map?config=${encodeURIComponent(configName)}` : '/api/policy-map';
          const r = await fetch(url);
          if (r.ok) savedMap = await r.json();
        } catch {}
      }
      const policies = await window.INTUNE.listPolicies({ configName, nameFilter: POLICY_NAME_FILTER });
      setIntunePolicies(policies);
      const LEGACY_KEYS = { 'mac-allow': ['mac-allow-chrome', 'mac-allow-edge'] };
      const deployMap = {};
      files.forEach(f => {
        deployMap[f.key] = savedMap[f.key] || (LEGACY_KEYS[f.key] || []).map(k => savedMap[k]).find(Boolean) || '';
      });
      setPolicyMap(deployMap);
      setDeployState('ticket');
    } catch (err) {
      toast.push('Failed to connect: ' + err.message, 'err');
      onClose();
    }
  };


  const getDeploymentItems = () => files.map(f => ({ ...f, targetId: policyMap[f.key] || null }));
  const getPolicyName = (id) => intunePolicies.find(p => p.id === id)?.name || 'Saved policy';

  const executeDeploy = async () => {
    setDeployState('deploying');
    setDeployResults([]);
    const items = getDeploymentItems();
    if (items.some(f => !f.targetId)) {
      setDeployResults(items.filter(f => !f.targetId).map(f => ({ title: f.title, status: 'error', error: 'No existing Intune policy mapped.' })));
      setDeployState('done');
      toast.push('Deployment blocked: map existing policies first', 'err');
      return;
    }
    const results = [];
    const idUpdates = {};
    for (let i = 0; i < items.length; i++) {
      const f = items[i];
      setDeployProgress(`${i + 1}/${items.length}: ${f.title}`);
      try {
        const r = await window.INTUNE.deployFile(f, f.targetId, { ticketNote, configName: selectedDeployConfig });
        results.push({ title: f.title, ...r });
        if (r.status === 'ok' && r.id) idUpdates[f.key] = r.id;
      } catch (err) {
        results.push({ title: f.title, status: 'error', error: err.message });
      }
    }
    setDeployResults(results);
    setDeployState('done');
    const ok = results.filter(r => r.status === 'ok').length;
    const fail = results.filter(r => r.status === 'error').length;
    if (ok > 0) {
      onDeployed();
      fetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data, tickets: parsedTickets }),
      }).catch(() => {});
    }
    toast.push(`Deployed: ${ok} ok${fail ? `, ${fail} failed` : ''}`, fail ? 'warn' : 'ok');
  };

  const isLoadingState = deployState === 'loading';
  return (
    <div className={`deploy-panel${isLoadingState ? ' deploy-panel--loading' : ''}`} ref={panelRef}>
      {deployState === 'select-config' && (
        <div className="deploy-config-select">
          <div className="deploy-config-select__header">
            <div className="deploy-config-select__icon"><Icon.Cloud /></div>
            <div>
              <div className="deploy-config-select__title">Select tenant</div>
              <div className="deploy-config-select__sub">Choose which Intune configuration to deploy to</div>
            </div>
          </div>
          <div className="deploy-config-select__options">
            {allConfigs.map(c => (
              <button
                key={c.name}
                className={`deploy-config-select__opt${selectedDeployConfig === c.name ? ' deploy-config-select__opt--active' : ''}`}
                onClick={() => setSelectedDeployConfig(c.name)}
              >
                <Icon.Shield />
                {c.name}
              </button>
            ))}
          </div>
          <div className="deploy-panel__actions">
            <button className="btn btn--primary btn--sm" onClick={() => startDeploy(selectedDeployConfig)} disabled={!selectedDeployConfig}>
              <Icon.Cloud /> Continue
            </button>
            <button className="btn btn--ghost btn--sm" onClick={onClose}>Cancel</button>
          </div>
        </div>
      )}
      {deployState === 'loading' && (
        <div className="deploy-panel__progress"><Icon.Spinner /> <span>{deployProgress}</span></div>
      )}
      {deployState === 'ticket' && (
        <>
          <div className="deploy-panel__info">
            <strong>Ticket reference</strong>
            <p>Paste ticket URLs or IDs — will be saved to the policy description. You can add multiple, separated by spaces or commas.</p>
          </div>
          <div className="deploy-panel__field">
            <label>Tickets</label>
            <textarea
              ref={ticketRef}
              className="deploy-panel__ticket-input"
              placeholder={ticketPlaceholder}
              value={ticketInput}
              onChange={e => setTicketInput(e.target.value)}
              rows={2}
            />
          </div>
          {parsedTickets.length > 0 && (
            <div className="deploy-panel__ticket-preview">
              <span className="deploy-panel__ticket-label">Ticket:</span>
              {parsedTickets.map(t => <span key={t} className="deploy-panel__ticket-chip">{t}</span>)}
            </div>
          )}
          <div className="deploy-panel__actions">
            <button className="btn btn--primary btn--sm" onClick={executeDeploy} disabled={parsedTickets.length === 0 || getDeploymentItems().some(i => !i.targetId)}>
              <Icon.Cloud /> Deploy
            </button>
            <button className="btn btn--ghost btn--sm" onClick={onClose}>Cancel</button>
          </div>
        </>
      )}
      {deployState === 'deploying' && (
        <div className="deploy-panel__progress"><Icon.Spinner /> <span>{deployProgress}</span></div>
      )}
      {deployState === 'done' && (
        <>
          <div className="deploy-panel__results">
            {deployResults.map((r, i) => (
              <div key={i} className={`deploy-result deploy-result--${r.status}`}>
                {r.status === 'ok' ? <Icon.Check /> : <Icon.AlertTriangle />}
                <span className="deploy-result__title">{r.title}</span>
                {r.status === 'ok' && <span className="deploy-result__id">{r.action}{r.assignmentsRestored ? ` · ${r.assignmentsRestored} assignments restored` : ''}</span>}
                {r.status === 'error' && <span className="deploy-result__err">{r.error}</span>}
              </div>
            ))}
          </div>
          <div className="deploy-panel__actions">
            <button className="btn btn--primary btn--sm" style={{ padding: '0 8px' }} onClick={onClose}>Close</button>
          </div>
        </>
      )}
    </div>
  );
}

// ============== Output View ==============
function OutputView({ isBlock, data }) {
  const files = useMemo(() => buildFiles(isBlock, data), [isBlock, data]);
  const [activeKey, setActiveKey] = useState(files[0].key);
  const active = files.find(f => f.key === activeKey) || files[0];

  useEffect(() => { setActiveKey(files[0].key); }, [isBlock]);

  const downloadOne = (f) => {
    const subs = f.files || [f];
    subs.forEach((sub, i) => setTimeout(() => {
      const blob = new Blob([sub.text], { type: f.mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = sub.filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 200);
    }, i * 150));
  };
  const downloadAll = () => files.forEach((f, i) => setTimeout(() => downloadOne(f), i * 300));

  const sizeBytes = new Blob([active.text]).size;
  const sizeStr = sizeBytes < 1024 ? `${sizeBytes} B` : `${(sizeBytes/1024).toFixed(1)} KB`;

  return (
    <div className="view view--output">
      <div className="output-files">
        {files.map(f => (
          <button
            key={f.key}
            className={`output-file ${activeKey===f.key?'output-file--active':''}`}
            onClick={() => setActiveKey(f.key)}
          >
            <div className="output-file__os">
              {f.os === 'windows' ? <Icon.Win /> : <Icon.Apple />}
            </div>
            <div className="output-file__body">
              <div className="output-file__title">{f.title}</div>
              <div className="output-file__sub">{f.subtitle}</div>
            </div>
            <button
              className="output-file__dl"
              onClick={(e) => { e.stopPropagation(); downloadOne(f); }}
              title="Download"
            >
              <Icon.Download />
            </button>
          </button>
        ))}
      </div>

      <div className="output-bulk">
        <button className="btn btn--primary btn--sm" onClick={downloadAll}>
          <Icon.Download /> Download all ({files.length})
        </button>
      </div>

      <div className="output-card">
        <div className="output-card__head">
          <div className="output-card__file">
            <span className="output-card__filename">{active.filename}</span>
            <span className="output-card__meta">{sizeStr} · {active.text.split('\n').length} lines</span>
          </div>
          <div className="output-card__actions">
            <CopyButton getText={() => active.text} />
            <button className="btn btn--primary btn--sm" onClick={() => downloadOne(active)}>
              <Icon.Download /> Download
            </button>
          </div>
        </div>
        <CodeBlock text={active.text} lang={active.lang} />
      </div>
    </div>
  );
}

// ============== Confirm modal ==============
function ConfirmModal({ title, description, confirmLabel = 'Confirm', onConfirm, onCancel }) {
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="modal">
        <div className="modal__head">
          <Icon.AlertTriangle /> {title}
        </div>
        <div className="modal__body">
          <p className="modal__desc">{description}</p>
          <div className="modal__actions">
            <button className="btn btn--primary btn--sm" onClick={onConfirm}>{confirmLabel}</button>
            <button className="btn btn--ghost btn--sm" onClick={onCancel}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============== Unlock modal ==============
function UnlockModal({ title, description, confirmLabel = 'Confirm', onConfirm, onCancel }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    setChecking(true);
    setError('');
    try {
      const r = await fetch('/api/settings-lock/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await r.json();
      if (data.ok) {
        window.EPM_API?.setUnlockToken(data.unlockToken);
        onConfirm();
      } else {
        setError('Incorrect password');
        setPassword('');
        inputRef.current?.focus();
      }
    } catch {
      setError('Server error');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="modal">
        <div className="modal__head">
          <Icon.Lock /> {title}
        </div>
        <div className="modal__body">
          <p className="modal__desc">{description}</p>
          <form onSubmit={submit} className="modal__form">
            <input
              ref={inputRef}
              type="password"
              className="settings-lock__input"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Settings password"
              autoComplete="current-password"
              spellCheck="false"
            />
            {error && <div className="settings-lock__error">{error}</div>}
            <div className="modal__actions">
              <button type="submit" className="btn btn--primary btn--sm" disabled={!password || checking}>
                {checking ? <><Icon.Spinner /> Checking…</> : confirmLabel}
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>Cancel</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ============== Settings lock gate ==============
function SettingsLockGate({ onUnlock }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    setChecking(true);
    setError('');
    try {
      const r = await fetch('/api/settings-lock/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await r.json();
      if (data.ok) {
        onUnlock(data.unlockToken);
      } else {
        setError('Incorrect password');
        setPassword('');
        inputRef.current?.focus();
      }
    } catch {
      setError('Server error');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="settings-lock">
      <div className="settings-lock__card">
        <div className="settings-lock__icon"><Icon.Shield /></div>
        <h2 className="settings-lock__title">Settings locked</h2>
        <p className="settings-lock__desc">Enter the password to access settings.</p>
        <form className="settings-lock__form" onSubmit={submit}>
          <input
            ref={inputRef}
            type="password"
            className="settings-lock__input"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete="current-password"
            spellCheck="false"
          />
          {error && <div className="settings-lock__error">{error}</div>}
          <button className="btn btn--primary" type="submit" disabled={!password || checking}>
            {checking ? <><Icon.Spinner /> Checking…</> : 'Unlock'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ============== Settings view ==============
function SettingsView({
  onImportAllow,
  onImportBlock,
  onExport,
  onLoadConfirm,
  onLockChange,
  settingsHasLock,
  hideBlocklist,
  onHideBlocklistChange,
  allowDeleteDeployed,
  onAllowDeleteDeployedChange,
  settingsTab,
  autoLockMs,
  onAutoLockMsChange,
}) {
  const toast = React.useContext(ToastContext);

  const [draftAutoLockMs, setDraftAutoLockMs] = useState(autoLockMs);
  const autoLockDirty = draftAutoLockMs !== autoLockMs;

  // Import & replace panel state
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importConsent, setImportConsent] = useState(false);
  const [importPassword, setImportPassword] = useState('');
  const [importLockError, setImportLockError] = useState('');
  const [importChecking, setImportChecking] = useState(false);
  const importPasswordRef = useRef(null);

  const openImport = () => { setImportOpen(true); setImportText(''); setImportConsent(false); setImportPassword(''); setImportLockError(''); setTimeout(() => importPasswordRef.current?.focus(), 50); };
  const closeImport = () => { setImportOpen(false); setImportText(''); setImportConsent(false); setImportPassword(''); setImportLockError(''); };

  const confirmImport = async () => {
    if (settingsHasLock) {
      setImportChecking(true);
      setImportLockError('');
      try {
        const r = await fetch('/api/settings-lock/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: importPassword }) });
        const d = await r.json();
        if (!d.ok) { setImportLockError('Incorrect password'); setImportPassword(''); importPasswordRef.current?.focus(); setImportChecking(false); return; }
      } catch { setImportLockError('Server error'); setImportChecking(false); return; }
      setImportChecking(false);
    }
    onLoadConfirm(importText);
    closeImport();
  };
  const initial = window.INTUNE.getSettings();
  const [configs, setConfigs] = useState(initial.configs || []);
  const initialConfig = (initial.configs || [])[0] || null;
  const [selectedConfigName, setSelectedConfigName] = useState(initialConfig?.name || '__new__');
  const [configName, setConfigName] = useState(initialConfig?.name || '');
  const [tenantId, setTenantId] = useState(initialConfig?.tenantId || '');
  const [clientId, setClientId] = useState(initialConfig?.clientId || '');
  const [clientSecret, setClientSecret] = useState('');
  const [hasSecret, setHasSecret] = useState(initialConfig?.hasSecret || false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const isNewConfig = selectedConfigName === '__new__';

  // Policy mapping
  const [policyMap, setPolicyMap] = useState(initialConfig?.policyMap || {});

  // Sync form when selected config changes
  useEffect(() => {
    const conf = configs.find(c => c.name === selectedConfigName) || null;
    setConfigName(conf?.name || '');
    setTenantId(conf?.tenantId || '');
    setClientId(conf?.clientId || '');
    setHasSecret(conf?.hasSecret || false);
    setPolicyMap(conf?.policyMap || {});
    setClientSecret('');
    setTestResult(null);
    setIntunePolicies(null);
    setMappingSaved(Object.values(conf?.policyMap || {}).some(Boolean));
  }, [selectedConfigName]);

  // Re-sync form if settingsCache wasn't ready at mount time
  useEffect(() => {
    window.INTUNE.loadSettings().then(() => {
      const s = window.INTUNE.getSettings();
      const newConfigs = s.configs || [];
      setConfigs(newConfigs);
      const sel = newConfigs.find(c => c.name === selectedConfigName) || newConfigs[0] || null;
      if (sel) {
        setSelectedConfigName(sel.name);
        setConfigName(sel.name);
        setTenantId(sel.tenantId);
        setClientId(sel.clientId);
        setHasSecret(sel.hasSecret);
        setPolicyMap(sel.policyMap || {});
        setMappingSaved(Object.values(sel.policyMap || {}).some(Boolean));
      }
      if (s.autoLockMs !== null && s.autoLockMs !== undefined) {
        setDraftAutoLockMs(s.autoLockMs);
        onAutoLockMsChange(s.autoLockMs);
      }
    });
  }, []);
  const [intunePolicies, setIntunePolicies] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem(`epm_intune_policies_${initialConfig?.name || ''}`) || 'null'); }
    catch { return null; }
  });
  const [fetchingPolicies, setFetchingPolicies] = useState(false);
  const [mappingSaved, setMappingSaved] = useState(() => Object.values(initialConfig?.policyMap || {}).some(Boolean));
  const [clearAllConfirm, setClearAllConfirm] = useState(false);

  const POLICY_SLOTS = [
    { key: 'win-allow-chrome', label: 'Windows Chrome', os: 'windows', group: 'allow' },
    { key: 'win-allow-edge',   label: 'Windows Edge',   os: 'windows', group: 'allow' },
    { key: 'mac-allow',        label: 'macOS Chrome + Edge', os: 'macos', group: 'allow' },
    { key: 'win-block-chrome', label: 'Windows Chrome', os: 'windows', group: 'block' },
    { key: 'win-block-edge',   label: 'Windows Edge',   os: 'windows', group: 'block' },
    { key: 'mac-block',        label: 'macOS Chrome + Edge', os: 'macos', group: 'block' },
  ];


  const save = async () => {
    const name = configName.trim();
    if (!name) { toast.push('Enter a configuration name', 'warn'); return; }
    const isRename = !isNewConfig && name !== selectedConfigName;
    const payload = { name, tenantId: tenantId.trim(), clientId: clientId.trim(), policyMap };
    if (clientSecret.trim()) payload.clientSecret = clientSecret.trim();
    if (isRename) payload.renameFrom = selectedConfigName;
    await window.INTUNE.setSettings(payload);
    const updatedConfig = { name, tenantId: tenantId.trim(), clientId: clientId.trim(), hasSecret: hasSecret || !!clientSecret.trim(), policyMap };
    setConfigs(prev => {
      if (isRename) return prev.map(c => c.name === selectedConfigName ? updatedConfig : c);
      const idx = prev.findIndex(c => c.name === name);
      return idx >= 0 ? prev.map((c, i) => i === idx ? updatedConfig : c) : [...prev, updatedConfig];
    });
    setSelectedConfigName(name);
    if (clientSecret.trim()) { setHasSecret(true); setClientSecret(''); }
    if (isRename) sessionStorage.removeItem(`epm_intune_policies_${selectedConfigName}`);
    sessionStorage.removeItem(`epm_intune_policies_${name}`);
    setIntunePolicies(null);
    toast.push('Settings saved' + (payload.clientSecret ? ' · secret encrypted on server' : ''), 'ok');
    setMappingSaved(true);
  };

  const testConn = async () => {
    await save();
    setTesting(true);
    setTestResult(null);
    try {
      const r = await window.INTUNE.testConnection(selectedConfigName);
      setTestResult({ ok: true, org: r.displayName, domain: r.domain });
      toast.push(`Connected to ${r.displayName}`, 'ok');
    } catch (err) {
      setTestResult({ ok: false, error: err.message });
      toast.push('Connection failed: ' + err.message, 'err');
    } finally { setTesting(false); }
  };

  const fetchPolicies = async () => {
    setFetchingPolicies(true);
    try {
      const policies = await window.INTUNE.listPolicies({ configName: selectedConfigName, nameFilter: POLICY_NAME_FILTER });
      setIntunePolicies(policies);
      sessionStorage.setItem(`epm_intune_policies_${selectedConfigName}`, JSON.stringify(policies));
      setPolicyMap(current => buildPolicyMap(POLICY_SLOTS.map(slot => slot.key), policies, current));
      toast.push(`Loaded ${policies.length} ${POLICY_NAME_FILTER} policies from Intune`, 'ok');
    } catch (err) {
      toast.push('Failed to fetch policies: ' + err.message, 'err');
    } finally { setFetchingPolicies(false); }
  };

  const doDeleteConfig = async () => {
    await window.INTUNE.deleteConfig(selectedConfigName);
    const newConfigs = configs.filter(c => c.name !== selectedConfigName);
    setConfigs(newConfigs);
    sessionStorage.removeItem(`epm_intune_policies_${selectedConfigName}`);
    const next = newConfigs[0] || null;
    setSelectedConfigName(next?.name || '__new__');
    toast.push('Configuration deleted', 'warn');
  };

  const isValid = /^[0-9a-f-]{36}$/i.test(tenantId.trim()) && /^[0-9a-f-]{36}$/i.test(clientId.trim());
  const canTest = isValid && (hasSecret || clientSecret.trim()) && !isNewConfig && configName.trim() === selectedConfigName;

  useEffect(() => {
    if (settingsTab === 'mapping' && canTest && !intunePolicies && !fetchingPolicies) {
      fetchPolicies();
    }
  }, [settingsTab, selectedConfigName]);

  return (
    <div className="settings-view view">
      {settingsTab === 'intune' && (
        <>
          <div style={{maxWidth:640, paddingLeft:8}}>
            <h3 className="settings-section__title" style={{marginBottom:6}}>Intune Connection</h3>
            <p className="settings-section__desc">
              App Registration with <code>Application</code> permissions and a client secret. Auth is handled server-side — the secret is encrypted at rest and never sent to the browser.
            </p>
          </div>

          <div className="settings-section">
            <h3 className="settings-section__title">Select Configuration</h3>
            <div className="settings-form">
              <div className="settings-field">
                <select
                  value={selectedConfigName}
                  onChange={e => setSelectedConfigName(e.target.value)}
                >
                  {configs.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                  <option value="__new__">+ New configuration…</option>
                </select>
              </div>
            </div>
            {isNewConfig && (
              <div className="settings-setup-steps">
                <div className="settings-step"><span className="settings-step__num">1</span> <a href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener">Azure Portal</a> → App registrations → New registration</div>
                <div className="settings-step"><span className="settings-step__num">2</span> API permissions → Add → <strong>Application</strong>: <code>DeviceManagementConfiguration.ReadWrite.All</code></div>
                <div className="settings-step"><span className="settings-step__num">3</span> Grant admin consent for the tenant</div>
                <div className="settings-step"><span className="settings-step__num">4</span> Certificates &amp; secrets → New client secret → copy <strong>Value</strong></div>
              </div>
            )}
          </div>

          <div className="settings-section">
            <div className="settings-form">
              <div className="settings-field">
                <label>Configuration name</label>
                <input
                  value={configName}
                  onChange={e => setConfigName(e.target.value)}
                  placeholder="e.g. Contoso Corp"
                  spellCheck="false"
                />
              </div>

              <div className="settings-field">
                <label>Tenant ID</label>
                <input value={tenantId} onChange={e => setTenantId(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" spellCheck="false" />
              </div>

              <div className="settings-field">
                <label>Application (client) ID</label>
                <input value={clientId} onChange={e => setClientId(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" spellCheck="false" />
              </div>

              <div className="settings-field">
                <label>Client Secret {hasSecret && <span className="settings-field__badge">encrypted ✓</span>}</label>
                <input
                  type="password"
                  value={clientSecret}
                  onChange={e => setClientSecret(e.target.value)}
                  placeholder={hasSecret ? '••••••••  (leave empty to keep current)' : 'Paste secret value'}
                  spellCheck="false"
                  autoComplete="off"
                />
                <span className="settings-field__hint">Encrypted with AES-256-GCM on the server. Never sent to the browser.</span>
              </div>

              <div className="settings-actions">
                <button className="btn btn--primary btn--sm" onClick={save} disabled={!isValid || (!hasSecret && !clientSecret.trim()) || (!isNewConfig ? false : !configName.trim())}>Save</button>
                <button className="btn btn--ghost btn--sm" onClick={testConn} disabled={!canTest || testing}>
                  {testing ? <><Icon.Spinner /> Testing…</> : 'Test connection'}
                </button>
                {!isNewConfig && (
                  <button className="btn btn--ghost btn--sm settings-btn--danger" onClick={() => setClearAllConfirm(true)}>Delete</button>
                )}
              </div>

              {testResult && (
                <div className={`settings-test ${testResult.ok ? 'settings-test--ok' : 'settings-test--err'}`}>
                  {testResult.ok
                    ? <><Icon.Check /> Connected to <strong>{testResult.org}</strong> ({testResult.domain})</>
                    : <><Icon.AlertTriangle /> {testResult.error}</>}
                </div>
              )}
            </div>
            {clearAllConfirm && (
              <ConfirmModal
                title={`Delete "${selectedConfigName}"`}
                description="This will remove the tenant ID, client ID, and encrypted secret for this configuration. The action cannot be undone."
                confirmLabel="Delete"
                onConfirm={() => { setClearAllConfirm(false); doDeleteConfig(); }}
                onCancel={() => setClearAllConfirm(false)}
              />
            )}
          </div>
        </>
      )}

      {settingsTab === 'mapping' && (() => {
        const visibleSlots = POLICY_SLOTS.filter(s => !hideBlocklist || s.group !== 'block');
        const mappedCount = visibleSlots.filter(s => policyMap[s.key]).length;
        const statusMod = mappedCount === visibleSlots.length ? 'ok' : mappedCount > 0 ? 'warn' : 'neutral';
        return (
        <div className="settings-section settings-section--wide">
          <div className="settings-section__title-row">
            <h3 className="settings-section__title">Policy Mapping</h3>
            <span className={`mapping-status tabs__count tabs__count--${statusMod}`}>
              {mappedCount}/{visibleSlots.length} mapped
            </span>
          </div>
          <div className="settings-form">
          {configs.length > 1 && (
            <div className="settings-field">
              <label>Configuration</label>
              <select value={selectedConfigName} onChange={e => setSelectedConfigName(e.target.value)}>
                {configs.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
            </div>
          )}
          <p className="settings-section__desc">
            Map each generated config to an existing Intune policy. Deployment is blocked when a mapping is missing; this tool will not create new policies.
          </p>

          <div className="policy-fetch-row">
            <button className="btn btn--ghost btn--sm" onClick={fetchPolicies} disabled={!canTest || fetchingPolicies}>
              {fetchingPolicies ? <><Icon.Spinner /> Loading…</> : <><Icon.Cloud /> Fetch policies from Intune</>}
            </button>
            {Object.keys(policyMap).some(k => policyMap[k]) && (
              <button
                className={`btn btn--sm${mappingSaved ? ' btn--saved' : ' btn--pending'}`}
                onClick={save}
              >
                {mappingSaved ? <><Icon.Check /> Mapping saved</> : 'Save mapping'}
              </button>
            )}
          </div>

          {['allow', ...(!hideBlocklist ? ['block'] : [])].map(group => (
            <div key={group} className="settings-mapping">
              <div className="settings-mapping__group-label">
                {group === 'allow' ? <><Icon.Shield /> Allowlist</> : <><Icon.Ban /> Blocklist</>}
              </div>
              {POLICY_SLOTS.filter(s => s.group === group).map(slot => {
                const relevant = (intunePolicies || []).filter(p =>
                  isBrowserExtensionPolicy(p) &&
                  (slot.os === 'windows' ? p.type === 'settingsCatalog' : p.type === 'macOSCustom')
                );
                const selectedPolicy = relevant.find(p => p.id === policyMap[slot.key]);
                return (
                  <div key={slot.key} className="settings-map-row">
                    <div className="settings-map-row__label">
                      {slot.os === 'windows' ? <Icon.Win /> : <Icon.Apple />}
                      <span>{slot.label}</span>
                    </div>
                    <div className="settings-map-row__picker">
                      <select
                        className="settings-map-row__select"
                        value={selectedPolicy ? selectedPolicy.id : ''}
                        onChange={e => { setPolicyMap(m => ({ ...m, [slot.key]: e.target.value })); setMappingSaved(false); }}
                        disabled={!intunePolicies}
                      >
                        <option value="">{intunePolicies ? '-- Select policy --' : 'Fetch policies first...'}</option>
                        {relevant.map(p => (
                          <option key={p.id} value={p.id}>
                            {p.name}{p.modified ? ` (${new Date(p.modified).toLocaleDateString()})` : ''}
                          </option>
                        ))}
                      </select>
                      {policyMap[slot.key] && (
                        <button className="iconbtn" onClick={() => { setPolicyMap(m => { const n = {...m}; delete n[slot.key]; return n; }); setMappingSaved(false); }} title="Unlink">
                          <Icon.X />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}

          {!intunePolicies && (
            <p className="settings-map-hint">Click "Fetch policies" to load existing Intune policies for mapping. You can also type a policy ID directly in the dropdown.</p>
          )}
          {intunePolicies && (
            <p className="settings-map-hint">Showing policies filtered by "{POLICY_NAME_FILTER}".</p>
          )}
          </div>
        </div>
        );
      })()}

      {settingsTab === 'data' && (
        <>
          <div className="settings-section settings-section--full">
            <h3 className="settings-section__title">Display</h3>
            <label className="settings-toggle">
              <input
                type="checkbox"
                className="settings-toggle__input"
                checked={hideBlocklist}
                onChange={e => onHideBlocklistChange(e.target.checked)}
              />
              <span className="settings-toggle__track">
                <span className="settings-toggle__thumb" />
              </span>
              <span className="settings-toggle__label">Hide Blocklist menu</span>
            </label>
          </div>

          <div className="settings-section settings-section--full">
            <h3 className="settings-section__title">Data</h3>
            <p className="settings-section__desc">
              Export or replace the local allowlist and blocklist data.
            </p>

            <div className="settings-actions">
              <button className="btn btn--ghost btn--sm" onClick={onExport} title="Export all data as JSON file">
                <Icon.Download /> Export
              </button>
              <button className={`btn btn--ghost btn--sm${importOpen ? ' btn--pending' : ''}`} onClick={importOpen ? closeImport : openImport}>
                <Icon.Upload /> Import and replace
              </button>
            </div>

            {importOpen && (
              <div className="import-replace-panel">
                <div className="import-replace-panel__warn">
                  <Icon.AlertTriangle /> This will <strong>replace all</strong> existing allowlist and blocklist data.
                </div>
                <textarea
                  className="load-panel__textarea"
                  placeholder='Paste exported JSON here...&#10;&#10;{ "allowlist": [...], "blocklist": [...] }'
                  value={importText}
                  onChange={e => setImportText(e.target.value)}
                  spellCheck="false"
                />
                {settingsHasLock && (
                  <div className="deploy-panel__field">
                    <label>Confirm with password</label>
                    <input
                      ref={importPasswordRef}
                      type="password"
                      className="deploy-panel__input"
                      placeholder="Settings password"
                      value={importPassword}
                      onChange={e => { setImportPassword(e.target.value); setImportLockError(''); }}
                      autoComplete="current-password"
                    />
                    {importLockError && <span style={{fontSize:'12px',color:'var(--err)'}}>{importLockError}</span>}
                  </div>
                )}
                <label className="settings-toggle" style={{marginTop:'4px'}}>
                  <input type="checkbox" className="settings-toggle__input" checked={importConsent} onChange={e => setImportConsent(e.target.checked)} />
                  <span className="settings-toggle__track"><span className="settings-toggle__thumb" /></span>
                  <span className="settings-toggle__label">I understand this will replace all existing data</span>
                </label>
                <div className="deploy-panel__actions">
                  <button
                    className="btn btn--primary btn--sm"
                    onClick={confirmImport}
                    disabled={!importText.trim() || !importConsent || (settingsHasLock && !importPassword) || importChecking}
                  >
                    {importChecking ? <><Icon.Spinner /> Verifying…</> : <><Icon.Upload /> Apply</>}
                  </button>
                  <button className="btn btn--ghost btn--sm" onClick={closeImport}>Cancel</button>
                </div>
              </div>
            )}

            <hr className="settings-section__divider" />
            <h3 className="settings-section__title settings-section__title--mt">Import Config</h3>
            <p className="settings-section__desc">
              Import existing Chrome and Edge policy files into the allowlist or blocklist.
            </p>
            <div className="settings-import-split">
              <div className="settings-import-col">
                <div className="settings-import-col__label">Allow</div>
                <ImportView isBlock={false} onImport={onImportAllow} />
              </div>
              {!hideBlocklist && (
                <div className="settings-import-col">
                  <div className="settings-import-col__label">Block</div>
                  <ImportView isBlock={true} onImport={onImportBlock} />
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {settingsTab === 'security' && (
        <>
          <div className="settings-section">
            <h3 className="settings-section__title">Settings Lock</h3>
            <p className="settings-section__desc">
              Protect the settings page with a password. Checked once per browser session.
            </p>
            <div className="settings-form">
              <SettingsLockManager onLockChange={onLockChange} />
            </div>
          </div>

          <div className="settings-section">
            <h3 className="settings-section__title">Deployed extensions</h3>
            <p className="settings-section__desc">
              By default, deleting a deployed extension requires the settings password. Enable this to allow deletion without a password prompt.
            </p>
            <label className="settings-toggle">
              <input
                type="checkbox"
                className="settings-toggle__input"
                checked={allowDeleteDeployed}
                onChange={e => onAllowDeleteDeployedChange(e.target.checked)}
              />
              <span className="settings-toggle__track">
                <span className="settings-toggle__thumb" />
              </span>
              <span className="settings-toggle__label">Allow deleting deployed extensions without password</span>
            </label>
          </div>

          {settingsHasLock && (
            <div className="settings-section">
              <h3 className="settings-section__title">Auto-lock timer</h3>
              <p className="settings-section__desc">
                Automatically lock settings after the session has been unlocked for this long.
              </p>
              <div className="settings-form">
                <div className="settings-field">
                  <label>Lock after</label>
                  <select
                    value={String(draftAutoLockMs)}
                    onChange={e => setDraftAutoLockMs(Number(e.target.value))}
                  >
                    <option value="0">Never</option>
                    <option value={String(5 * 60 * 1000)}>5 minutes</option>
                    <option value={String(15 * 60 * 1000)}>15 minutes</option>
                    <option value={String(30 * 60 * 1000)}>30 minutes</option>
                    <option value={String(60 * 60 * 1000)}>1 hour</option>
                    <option value={String(4 * 60 * 60 * 1000)}>4 hours</option>
                  </select>
                  {autoLockDirty && (
                    <div className="settings-field__actions">
                      <button className="btn btn--sm btn--primary" onClick={() => onAutoLockMsChange(draftAutoLockMs)}>
                        Apply
                      </button>
                      <button className="btn btn--ghost btn--sm" onClick={() => setDraftAutoLockMs(autoLockMs)}>
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {settingsTab === 'history' && <HistoryView />}
    </div>
  );
}

// ============== History view ==============
function HistoryView() {
  const toast = React.useContext(ToastContext);
  const [entries, setEntries] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [restoring, setRestoring] = useState(null);

  useEffect(() => {
    fetch('/api/history')
      .then(r => r.json())
      .then(d => setEntries([...d].reverse()))
      .catch(() => setEntries([]));
  }, []);

  const rollback = async (id) => {
    setRestoring(id);
    try {
      const r = await (window.EPM_API?.fetch || fetch)(`/api/history/${id}/rollback`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { toast.push(d.error || 'Rollback failed', 'err'); return; }
      toast.push('State restored — reload to apply', 'ok');
      window.location.reload();
    } catch (e) {
      toast.push('Rollback failed: ' + e.message, 'err');
    } finally {
      setRestoring(null);
    }
  };

  if (entries === null) return <div className="history-empty"><Icon.Spinner /> Loading…</div>;
  if (entries.length === 0) return (
    <div className="history-empty">
      <Icon.History />
      <p>No deploy history yet. History is recorded automatically after each successful deploy to Intune.</p>
    </div>
  );

  return (
    <div className="history-list">
      {entries.map(entry => {
        const isOpen = expanded === entry.id;
        const totalAdded   = (entry.diff?.allowlist?.added?.length   || 0) + (entry.diff?.blocklist?.added?.length   || 0);
        const totalRemoved = (entry.diff?.allowlist?.removed?.length || 0) + (entry.diff?.blocklist?.removed?.length || 0);
        const date = new Date(entry.timestamp);
        return (
          <div key={entry.id} className={`history-entry${isOpen ? ' history-entry--open' : ''}`}>
            <button className="history-entry__head" onClick={() => setExpanded(isOpen ? null : entry.id)}>
              <span className="history-entry__icon"><Icon.Cloud /></span>
              <span className="history-entry__meta">
                <span className="history-entry__date">
                  {date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
                  {' '}
                  <span className="history-entry__time">{date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
                </span>
                {entry.tickets?.length > 0 && (
                  <span className="history-entry__tickets">
                    {entry.tickets.map(t => <span key={t} className="history-ticket">{t}</span>)}
                  </span>
                )}
              </span>
              <span className="history-entry__badges">
                {totalAdded   > 0 && <span className="history-badge history-badge--add">+{totalAdded}</span>}
                {totalRemoved > 0 && <span className="history-badge history-badge--rem">−{totalRemoved}</span>}
                {totalAdded === 0 && totalRemoved === 0 && <span className="history-badge history-badge--nc">no changes</span>}
              </span>
              <span className={`history-entry__chevron${isOpen ? ' history-entry__chevron--open' : ''}`}><Icon.ChevronDown /></span>
            </button>

            {isOpen && (
              <div className="history-entry__body">
                {['allowlist', 'blocklist'].map(listKey => {
                  const added   = entry.diff?.[listKey]?.added   || [];
                  const removed = entry.diff?.[listKey]?.removed || [];
                  if (!added.length && !removed.length) return null;
                  const all = [...added, ...removed];
                  const hasChromeIds = all.some(i => i.chromeId);
                  const hasEdgeIds   = all.some(i => i.edgeId);
                  const cols = `14px 1fr${hasChromeIds ? ' auto' : ''}${hasEdgeIds ? ' auto' : ''}`;
                  return (
                    <div key={listKey} className="history-diff">
                      <div className="history-diff__title">{listKey === 'allowlist' ? 'Allowlist' : 'Blocklist'}</div>
                      <div className="history-diff__table" style={{ gridTemplateColumns: cols }}>
                        <span /><span />
                        {hasChromeIds && <span className="history-diff__col-hdr"><Icon.Chrome width={11} height={11} strokeWidth={1.8} /> Chrome</span>}
                        {hasEdgeIds   && <span className="history-diff__col-hdr"><Icon.Edge   width={11} height={11} strokeWidth={1.8} /> Edge</span>}
                        {added.map((item, i) => (
                          <React.Fragment key={`a${i}`}>
                            <span className="history-diff__sign history-diff__sign--add">+</span>
                            <span className="history-diff__name">{item.name || 'Unknown'}</span>
                            {hasChromeIds && <span className="history-diff__id">{item.chromeId || ''}</span>}
                            {hasEdgeIds   && <span className="history-diff__id">{item.edgeId   || ''}</span>}
                          </React.Fragment>
                        ))}
                        {removed.map((item, i) => (
                          <React.Fragment key={`r${i}`}>
                            <span className="history-diff__sign history-diff__sign--rem">−</span>
                            <span className="history-diff__name history-diff__name--rem">{item.name || 'Unknown'}</span>
                            {hasChromeIds && <span className="history-diff__id history-diff__id--rem">{item.chromeId || ''}</span>}
                            {hasEdgeIds   && <span className="history-diff__id history-diff__id--rem">{item.edgeId   || ''}</span>}
                          </React.Fragment>
                        ))}
                      </div>
                    </div>
                  );
                })}
                <div className="history-entry__actions">
                  <button
                    className="btn btn--sm btn--ghost"
                    onClick={() => rollback(entry.id)}
                    disabled={!!restoring}
                  >
                    {restoring === entry.id ? <><Icon.Spinner /> Restoring…</> : <><Icon.RotateCcw /> Restore this state</>}
                  </button>
                  <button
                    className="btn btn--sm btn--ghost"
                    onClick={async () => {
                      const r = await fetch(`/api/history/${entry.id}/snapshot`);
                      const data = await r.json();
                      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `snapshot-${entry.id.replace(/[:.]/g, '-')}.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    <Icon.Download /> Download snapshot
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ============== Settings lock manager ==============
function SettingsLockManager({ onLockChange }) {
  const toast = React.useContext(ToastContext);
  const [hasLock, setHasLock] = useState(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [removingConfirm, setRemovingConfirm] = useState(false);

  useEffect(() => {
    fetch('/api/settings-lock').then(r => r.json()).then(d => setHasLock(d.hasPassword)).catch(() => setHasLock(false));
  }, []);

  const setLock = async (e) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) { toast.push('Passwords do not match', 'err'); return; }
    if (newPassword.length < 10) { toast.push('Password must be at least 10 characters', 'err'); return; }
    setSaving(true);
    try {
      const r = await (window.EPM_API?.fetch || fetch)('/api/settings-lock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: newPassword }),
      });
      if (!r.ok) throw new Error((await r.json()).error || 'Failed');
      const data = await r.json();
      window.EPM_API?.setUnlockToken(data.unlockToken);
      setHasLock(true);
      onLockChange(true);
      setNewPassword('');
      setConfirmPassword('');
      toast.push(hasLock ? 'Password changed' : 'Settings lock enabled', 'ok');
    } catch (err) {
      toast.push(err.message, 'err');
    } finally { setSaving(false); }
  };

  const removeLock = async () => {
    const r = await (window.EPM_API?.fetch || fetch)('/api/settings-lock', { method: 'DELETE' });
    if (!r.ok) { toast.push('Failed to remove settings lock', 'err'); return; }
    setHasLock(false);
    onLockChange(false);
    window.EPM_API?.clearUnlockToken();
    toast.push('Settings lock removed', 'warn');
  };

  if (hasLock === null) return null;

  return (
    <div className="settings-lock-mgr">
      {hasLock && (
        <div className="settings-lock-mgr__status">
          <Icon.Check /> Lock active
          <button className="btn btn--sm settings-btn--danger" onClick={() => setRemovingConfirm(true)}>Remove lock</button>
        </div>
      )}
      {removingConfirm && (
        <ConfirmModal
          title="Remove settings lock"
          description="The settings page will no longer require a password. Are you sure?"
          confirmLabel="Remove lock"
          onConfirm={() => { setRemovingConfirm(false); removeLock(); }}
          onCancel={() => setRemovingConfirm(false)}
        />
      )}
      <form className="settings-lock-mgr__form" onSubmit={setLock}>
        <div className="settings-field">
          <label>{hasLock ? 'Change password' : 'New password'}</label>
          <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
            placeholder="Min. 10 characters" autoComplete="new-password" spellCheck="false" />
        </div>
        <div className="settings-field">
          <label>Confirm password</label>
          <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
            placeholder="Repeat password" autoComplete="new-password" spellCheck="false" />
        </div>
        <div className="settings-actions">
          <button className="btn btn--primary btn--sm" type="submit" disabled={!newPassword || saving}>
            {saving ? <><Icon.Spinner /> Saving…</> : (hasLock ? 'Change password' : 'Set password')}
          </button>
        </div>
      </form>
    </div>
  );
}

// ============== Import config view ==============
function ImportView({ isBlock, onImport }) {
  const toast = React.useContext(ToastContext);
  const [chromeData, setChromeData] = useState(null);
  const [edgeData, setEdgeData]     = useState(null);
  const [importConfirm, setImportConfirm] = useState(false);

  const handleFile = async (file, slot) => {
    let text;
    try {
      text = await file.text();
    } catch {
      toast.push('Failed to read file', 'err');
      return;
    }
    const result = window.PARSERS.parseConfigFile(text, file.name);

    if (result.error) {
      toast.push(result.error, 'err');
      return;
    }

    if (result.type === 'mobileconfig') {
      // Combined profile (like blocklist) — auto-fill both slots from one file
      if (result.chrome.length > 0 && result.edge.length > 0) {
        setChromeData({ name: file.name, entries: result.chrome });
        setEdgeData({ name: file.name, entries: result.edge });
        toast.push(`Combined profile: ${result.chrome.length} Chrome + ${result.edge.length} Edge entries`, 'ok');
        return;
      }
      // Single-browser profile
      if (slot === 'chrome') {
        if (result.chrome.length > 0) {
          setChromeData({ name: file.name, entries: result.chrome });
          toast.push(`${result.chrome.length} Chrome entries`, 'ok');
        } else if (result.edge.length > 0) {
          toast.push('This file contains Edge config, not Chrome. Drop it on the Edge slot.', 'warn');
        } else {
          toast.push('No extension entries found', 'warn');
        }
      } else {
        if (result.edge.length > 0) {
          setEdgeData({ name: file.name, entries: result.edge });
          toast.push(`${result.edge.length} Edge entries`, 'ok');
        } else if (result.chrome.length > 0) {
          toast.push('This file contains Chrome config, not Edge. Drop it on the Chrome slot.', 'warn');
        } else {
          toast.push('No extension entries found', 'warn');
        }
      }
    } else if (result.type === 'json' || result.type === 'id-list') {
      if (result.entries.length === 0) {
        toast.push('No extension entries found', 'warn');
        return;
      }
      const w = result.warnings || [];
      if (slot === 'chrome') {
        setChromeData({ name: file.name, entries: result.entries, warnings: w });
      } else {
        setEdgeData({ name: file.name, entries: result.entries, warnings: w });
      }
      let msg = `${result.entries.length} entries from ${file.name}`;
      if (result.type === 'id-list') msg += ' (plain ID list)';
      if (w.length) msg += ` · ${w.length} warning${w.length > 1 ? 's' : ''}`;
      toast.push(msg, w.length ? 'warn' : 'ok');
    }
  };

  const handleText = (text, slot) => {
    const result = window.PARSERS.parseConfigFile(text, '');
    if (result.error) { toast.push(result.error, 'err'); return; }
    if (result.type === 'mobileconfig') {
      if (result.chrome.length > 0 && result.edge.length > 0) {
        setChromeData({ name: 'pasted text', entries: result.chrome });
        setEdgeData({ name: 'pasted text', entries: result.edge });
        toast.push(`Combined: ${result.chrome.length} Chrome + ${result.edge.length} Edge`, 'ok');
        return;
      }
      const bucket = result.chrome.length > 0 ? result.chrome : result.edge;
      if (bucket.length === 0) { toast.push('No entries found', 'warn'); return; }
      const setter = slot === 'chrome' ? setChromeData : setEdgeData;
      setter({ name: 'pasted text', entries: bucket });
      toast.push(`${bucket.length} entries`, 'ok');
      return;
    }
    const entries = result.entries || [];
    if (entries.length === 0) { toast.push('No entries found', 'warn'); return; }
    const w = result.warnings || [];
    const setter = slot === 'chrome' ? setChromeData : setEdgeData;
    setter({ name: 'pasted text', entries, warnings: w });
    let msg = `${entries.length} entries parsed`;
    if (w.length) msg += ` · ${w.length} warning${w.length > 1 ? 's' : ''}`;
    toast.push(msg, w.length ? 'warn' : 'ok');
  };

  const canImport = !!chromeData && !!edgeData;

  const doImport = () => {
    if (!canImport) return;
    setImportConfirm(true);
  };

  const confirmImportEntries = () => {
    setImportConfirm(false);
    onImport(chromeData.entries, edgeData.entries);
    setChromeData(null); setEdgeData(null);
  };

  return (
    <div className="import-view">
      <div className="import-warning">
        <Icon.AlertTriangle />
        <div>
          <strong>Add to {isBlock ? 'blocklist' : 'allowlist'}</strong>
          <span>Only new entries will be added — existing ones are kept. Both Chrome and Edge configs are required before import.</span>
        </div>
      </div>

      <div className="import-slots">
        <ImportSlot
          browser="chrome"
          icon={<Icon.Chrome />}
          label="Chrome policy"
          hint=".json, .mobileconfig, or comma-separated IDs"
          data={chromeData}
          onFile={(f) => handleFile(f, 'chrome')}
          onText={handleText}
          onClear={() => setChromeData(null)}
        />
        <ImportSlot
          browser="edge"
          icon={<Icon.Edge />}
          label="Edge policy"
          hint=".json, .mobileconfig, or comma-separated IDs"
          data={edgeData}
          onFile={(f) => handleFile(f, 'edge')}
          onText={handleText}
          onClear={() => setEdgeData(null)}
        />
      </div>

      {!canImport && (chromeData || edgeData) && (
        <div className="import-missing">
          <Icon.Info />
          <span>{chromeData ? 'Now add the Edge config to continue.' : 'Now add the Chrome config to continue.'}</span>
        </div>
      )}

      {canImport && (
        <div className="import-actions">
          <div className="import-summary">
            <strong>{chromeData.entries.length}</strong> Chrome + <strong>{edgeData.entries.length}</strong> Edge entries ready — new ones will be added to the {isBlock ? 'blocklist' : 'allowlist'}.
          </div>
          <button className="btn btn--primary" onClick={doImport}>
            <Icon.Upload /> Add entries
          </button>
        </div>
      )}
      {importConfirm && (
        <ConfirmModal
          title={`Add to ${isBlock ? 'blocklist' : 'allowlist'}`}
          description={`Add ${chromeData.entries.length} Chrome + ${edgeData.entries.length} Edge entries? Existing entries will not be removed.`}
          confirmLabel="Add entries"
          onConfirm={confirmImportEntries}
          onCancel={() => setImportConfirm(false)}
        />
      )}
    </div>
  );
}

function ImportSlot({ browser, icon, label, hint, data, onFile, onText, onClear }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [pasteText, setPasteText] = useState('');

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) onFile(file);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setDragOver(true);
  };

  const applyText = () => {
    if (pasteText.trim()) {
      onText(pasteText, browser);
      setPasteText('');
      setManualMode(false);
    }
  };

  if (data) {
    return (
      <div className={`import-slot import-slot--${browser} import-slot--filled`}>
        <div className="import-slot__icon">{icon}</div>
        <div className="import-slot__body">
          <div className="import-slot__label">{label}</div>
          <div className="import-slot__file">
            <Icon.File />
            <span className="import-slot__filename">{data.name}</span>
          </div>
          <div className="import-slot__count">{data.entries.length} extension{data.entries.length === 1 ? '' : 's'} found</div>
          {data.warnings && data.warnings.length > 0 && (
            <div className="import-slot__warnings">
              {data.warnings.map((w, i) => <div key={i} className="import-slot__warn-item"><Icon.AlertTriangle /> {w}</div>)}
            </div>
          )}
        </div>
        <button className="iconbtn" onClick={onClear} title="Remove"><Icon.X /></button>
      </div>
    );
  }

  if (manualMode) {
    return (
      <div className={`import-slot import-slot--${browser} import-slot--manual`}>
        <div className="import-slot__icon">{icon}</div>
        <div className="import-slot__body">
          <div className="import-slot__label">{label}</div>
          <textarea
            className="import-slot__textarea"
            placeholder="Paste JSON, comma-separated IDs, or mobileconfig…"
            value={pasteText}
            onChange={e => setPasteText(e.target.value)}
            spellCheck="false"
            autoFocus
          />
          <div className="import-slot__manual-actions">
            <button className="btn btn--primary btn--sm" onClick={applyText} disabled={!pasteText.trim()}>Apply</button>
            <button className="btn btn--ghost btn--sm" onClick={() => { setManualMode(false); setPasteText(''); }}>Cancel</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`import-slot import-slot--${browser} import-slot--empty ${dragOver ? 'import-slot--dragover' : ''}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={() => setDragOver(false)}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".json,.mobileconfig,.xml,.txt"
        style={{ display: 'none' }}
        onChange={(e) => { if (e.target.files[0]) onFile(e.target.files[0]); e.target.value = ''; }}
      />
      <div className="import-slot__icon">{icon}</div>
      <div className="import-slot__body">
        <div className="import-slot__label">{label}</div>
        <div className="import-slot__hint">{hint}</div>
        <div className="import-slot__cta">Drop file or click to browse</div>
        <button className="import-slot__paste-btn" type="button" onClick={(e) => { e.stopPropagation(); setManualMode(true); }}>
          or paste text manually
        </button>
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);

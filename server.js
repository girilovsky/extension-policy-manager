const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

// AES-256-GCM encryption for client secret at rest
const CIPHER_ALG = 'aes-256-gcm';
const SECRET_KEY = process.env.EPM_SECRET_KEY
  || crypto.createHash('sha256').update('epm-default-key-change-me').digest();
const UNLOCK_TTL_MS = 12 * 60 * 60 * 1000;

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(CIPHER_ALG, SECRET_KEY, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return iv.toString('hex') + ':' + tag + ':' + enc;
}

function decrypt(blob) {
  const [ivHex, tagHex, enc] = blob.split(':');
  const decipher = crypto.createDecipheriv(CIPHER_ALG, SECRET_KEY,
    Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  let dec = decipher.update(enc, 'hex', 'utf8');
  dec += decipher.final('utf8');
  return dec;
}

// ======== Data files ========
fs.mkdirSync(DATA_DIR, { recursive: true });
const dataFile    = () => path.join(DATA_DIR, 'extensions.json');
const configFile  = () => path.join(DATA_DIR, 'config.json');
const historyFile = () => path.join(DATA_DIR, 'history.json');

if (!fs.existsSync(dataFile()))    fs.writeFileSync(dataFile(), 'null');
if (!fs.existsSync(configFile()))  fs.writeFileSync(configFile(), '{}');
if (!fs.existsSync(historyFile())) fs.writeFileSync(historyFile(), '[]');

// ======== History helpers ========
const HISTORY_MAX = 100;

function readHistory() {
  try { return JSON.parse(fs.readFileSync(historyFile(), 'utf8')) || []; }
  catch { return []; }
}

function writeHistory(entries) {
  fs.writeFileSync(historyFile(), JSON.stringify(entries, null, 2));
}

function computeDiff(prev, next) {
  const diff = {};
  for (const listKey of ['allowlist', 'blocklist']) {
    const prevList = (prev?.[listKey] || []);
    const nextList = (next?.[listKey] || []);
    const key = (item) => [item.chromeId, item.edgeId].filter(Boolean).join('|') || item.name;
    const prevMap = new Map(prevList.map(i => [key(i), i]));
    const nextMap = new Map(nextList.map(i => [key(i), i]));
    diff[listKey] = {
      added:   nextList.filter(i => !prevMap.has(key(i))).map(({ name, chromeId, edgeId }) => ({ name, chromeId, edgeId })),
      removed: prevList.filter(i => !nextMap.has(key(i))).map(({ name, chromeId, edgeId }) => ({ name, chromeId, edgeId })),
    };
  }
  return diff;
}

function readConfig() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configFile(), 'utf8')); }
  catch { cfg = {}; }
  // Migrate flat single-config format → configs array
  if (!Array.isArray(cfg.configs)) {
    const hasOld = cfg.tenantId || cfg.clientId || cfg.encSecret;
    cfg.configs = hasOld
      ? [{ name: 'Default', tenantId: cfg.tenantId || '', clientId: cfg.clientId || '', encSecret: cfg.encSecret || '', policyMap: cfg.policyMap || {} }]
      : [];
    delete cfg.tenantId; delete cfg.clientId; delete cfg.encSecret; delete cfg.policyMap;
    fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
  }
  return cfg;
}

function writeConfig(obj) {
  fs.writeFileSync(configFile(), JSON.stringify(obj, null, 2));
}

function getSettingsLock() {
  return readConfig().settingsLock || null;
}

function verifySettingsPassword(password) {
  const lock = getSettingsLock();
  if (!lock) return true;
  const attempt = crypto.pbkdf2Sync(password || '', lock.salt, 100000, 32, 'sha256');
  const expected = Buffer.from(lock.hash, 'hex');
  return attempt.length === expected.length && crypto.timingSafeEqual(attempt, expected);
}

function createUnlockToken() {
  const payload = {
    exp: Date.now() + UNLOCK_TTL_MS,
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET_KEY).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyUnlockToken(token) {
  if (!getSettingsLock()) return true;
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET_KEY).update(body).digest('base64url');
  if (
    !sig ||
    Buffer.byteLength(sig) !== Buffer.byteLength(expected) ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return Number(payload.exp) > Date.now();
  } catch {
    return false;
  }
}

function requireSettingsUnlock(req, res, next) {
  if (verifyUnlockToken(req.get('x-epm-unlock'))) return next();
  return res.status(423).json({ error: 'Settings locked' });
}

app.use(express.json({ limit: '5mb' }));

// ======== Extension data API ========
app.get('/api/data', (req, res) => {
  try { res.type('json').send(fs.readFileSync(dataFile(), 'utf8')); }
  catch { res.status(404).json({ error: 'not found' }); }
});

app.put('/api/data', (req, res) => {
  try {
    fs.writeFileSync(dataFile(), JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ======== History API ========
app.get('/api/history', (req, res) => {
  const entries = readHistory();
  res.json(entries.map(({ snapshot: _, ...e }) => e));
});

app.post('/api/history', (req, res) => {
  try {
    const { data, tickets = [] } = req.body;
    if (!data) return res.status(400).json({ error: 'data required' });
    const entries = readHistory();
    const prevData = entries.length ? entries[entries.length - 1].snapshot : null;
    const entry = {
      id: new Date().toISOString(),
      timestamp: new Date().toISOString(),
      tickets,
      diff: computeDiff(prevData, data),
      snapshot: data,
    };
    entries.push(entry);
    if (entries.length > HISTORY_MAX) entries.splice(0, entries.length - HISTORY_MAX);
    writeHistory(entries);
    const { snapshot: _, ...pub } = entry;
    res.json({ ok: true, entry: pub });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/history/:id/snapshot', (req, res) => {
  const entries = readHistory();
  const entry = entries.find(e => e.id === req.params.id);
  if (!entry?.snapshot) return res.status(404).json({ error: 'not found' });
  res.json(entry.snapshot);
});

app.post('/api/history/:id/rollback', requireSettingsUnlock, (req, res) => {
  try {
    const entries = readHistory();
    const entry = entries.find(e => e.id === req.params.id);
    if (!entry?.snapshot) return res.status(404).json({ error: 'not found' });
    fs.writeFileSync(dataFile(), JSON.stringify(entry.snapshot, null, 2));
    res.json({ ok: true, data: entry.snapshot });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ======== Policy map (public — no credentials) ========
app.get('/api/policy-map', (req, res) => {
  const cfg = readConfig();
  const configName = req.query.config;
  const conf = configName ? cfg.configs.find(c => c.name === configName) : cfg.configs[0];
  res.json(conf?.policyMap || {});
});

// ======== Config API (secrets encrypted at rest) ========
app.get('/api/config', requireSettingsUnlock, (req, res) => {
  const cfg = readConfig();
  res.json({
    configs: cfg.configs.map(c => ({
      name: c.name,
      tenantId: c.tenantId || '',
      clientId: c.clientId || '',
      hasSecret: !!c.encSecret,
      policyMap: c.policyMap || {},
    })),
    autoLockMs: cfg.autoLockMs ?? null,
  });
});

// Upsert a named config (or save autoLockMs without a config name)
app.put('/api/config', requireSettingsUnlock, (req, res) => {
  try {
    const cfg = readConfig();
    const { name, renameFrom, tenantId, clientId, clientSecret, policyMap, autoLockMs } = req.body;
    if (autoLockMs !== undefined) cfg.autoLockMs = autoLockMs;
    if (name !== undefined) {
      // Rename: find old config, move it, delete old entry
      if (renameFrom && renameFrom !== name) {
        const oldIdx = cfg.configs.findIndex(c => c.name === renameFrom);
        if (oldIdx >= 0) {
          cfg.configs[oldIdx].name = name;
          delete tokenCache[renameFrom];
        }
      }
      let conf = cfg.configs.find(c => c.name === name);
      if (!conf) { conf = { name }; cfg.configs.push(conf); }
      if (tenantId !== undefined) conf.tenantId = tenantId;
      if (clientId !== undefined) conf.clientId = clientId;
      if (clientSecret) conf.encSecret = encrypt(clientSecret);
      if (policyMap !== undefined) conf.policyMap = policyMap;
      if (tenantId || clientId || clientSecret) delete tokenCache[name];
    }
    writeConfig(cfg);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Delete a named config
app.delete('/api/config/:name', requireSettingsUnlock, (req, res) => {
  const cfg = readConfig();
  const name = decodeURIComponent(req.params.name);
  cfg.configs = cfg.configs.filter(c => c.name !== name);
  delete tokenCache[name];
  writeConfig(cfg);
  res.json({ ok: true });
});

// ======== Settings lock ========
app.get('/api/settings-lock', (req, res) => {
  const cfg = readConfig();
  res.json({ hasPassword: !!cfg.settingsLock, autoLockMs: cfg.autoLockMs ?? null });
});

app.post('/api/settings-lock', (req, res) => {
  const { password } = req.body;
  if (!password || typeof password !== 'string' || password.length < 10) {
    return res.status(400).json({ error: 'Password must be at least 10 characters' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
  const cfg = readConfig();
  if (cfg.settingsLock && !verifyUnlockToken(req.get('x-epm-unlock'))) {
    return res.status(423).json({ error: 'Settings locked' });
  }
  cfg.settingsLock = { hash, salt };
  writeConfig(cfg);
  res.json({ ok: true, unlockToken: createUnlockToken() });
});

app.post('/api/settings-lock/verify', (req, res) => {
  const { password } = req.body;
  const cfg = readConfig();
  if (!cfg.settingsLock) return res.json({ ok: true, unlockToken: createUnlockToken() });
  const ok = verifySettingsPassword(password);
  res.json({ ok, ...(ok ? { unlockToken: createUnlockToken() } : {}) });
});

app.delete('/api/settings-lock', requireSettingsUnlock, (req, res) => {
  const cfg = readConfig();
  delete cfg.settingsLock;
  writeConfig(cfg);
  res.json({ ok: true });
});

// ======== Token cache (per config) ========
let tokenCache = {}; // { [configName]: { token, expiry } }

app.post('/api/token/flush', (req, res) => {
  const configName = req.body?.config;
  if (configName) delete tokenCache[configName];
  else tokenCache = {};
  res.json({ ok: true });
});

// ======== Graph proxy (avoids CORS, adds auth) ========
app.use('/api/graph', async (req, res) => {
  try {
    const configName = req.get('x-epm-config') || '';
    const cfg = readConfig();
    const conf = cfg.configs.find(c => c.name === configName) || cfg.configs[0];
    if (!conf?.tenantId || !conf?.clientId || !conf?.encSecret) {
      return res.status(400).json({ error: 'Intune not configured' });
    }
    const cacheKey = conf.name;
    const cache = tokenCache[cacheKey] || { token: null, expiry: 0 };
    if (!cache.token || Date.now() >= cache.expiry - 60000) {
      const secret = decrypt(conf.encSecret);
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: conf.clientId,
        client_secret: secret,
        scope: 'https://graph.microsoft.com/.default',
      });
      const tr = await fetch(
        `https://login.microsoftonline.com/${conf.tenantId}/oauth2/v2.0/token`,
        { method: 'POST', body }
      );
      const td = await tr.json();
      if (!tr.ok) return res.status(tr.status).json({ error: td.error_description || 'auth failed' });
      tokenCache[cacheKey] = { token: td.access_token, expiry: Date.now() + (td.expires_in || 3600) * 1000 };
    }

    const graphPath = req.url.startsWith('/') ? req.url.slice(1) : req.url;
    const graphUrl = `https://graph.microsoft.com/${graphPath}`;
    const opts = {
      method: req.method,
      headers: {
        Authorization: `Bearer ${tokenCache[cacheKey].token}`,
        'Content-Type': 'application/json',
      },
    };
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
      opts.body = JSON.stringify(req.body);
    }
    const gr = await fetch(graphUrl, opts);
    const contentType = gr.headers.get('content-type') || '';
    if (gr.status === 204) return res.status(204).end();
    if (contentType.includes('json')) {
      const gd = await gr.json();
      res.status(gr.status).json(gd);
    } else {
      const text = await gr.text();
      res.status(gr.status).type(contentType).send(text);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ======== Static files ========
app.use(express.static(PUBLIC_DIR));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, () => {
  console.log(`Extension Policy Manager listening on :${PORT}`);
  console.log(`  Static: ${PUBLIC_DIR}`);
  console.log(`  Data:   ${DATA_DIR}`);
});

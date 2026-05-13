// intune.js — Intune client via server proxy (/api/graph/*)
// Windows: Settings Catalog → configurationPolicies API
// macOS:   Custom Profile   → deviceConfigurations API

window.INTUNE = (function () {
  const GRAPH = 'beta/deviceManagement';
  const DEFAULT_POLICY_NAME_FILTER = 'Browser Extension';
  const UNLOCK_TOKEN_KEY = 'epm_settings_unlock_token';
  const EXTENSION_SETTING_DEFINITION_IDS = new Set([
    'google_chrome~policy~extensions_extensionsettings',
    'microsoft_edge~policy~extensions_extensionsettings',
    'device_vendor_msft_policy_config_microsoft_edgev80diff~policy~microsoft_edge~extensions_extensionsettings',
  ]);

  function setUnlockToken(token) {
    if (token) {
      sessionStorage.setItem(UNLOCK_TOKEN_KEY, token);
      sessionStorage.setItem('epm_settings_unlocked', '1');
    }
  }

  function clearUnlockToken() {
    sessionStorage.removeItem(UNLOCK_TOKEN_KEY);
    sessionStorage.removeItem('epm_settings_unlocked');
  }

  function authHeaders(headers = {}) {
    const token = sessionStorage.getItem(UNLOCK_TOKEN_KEY);
    return token ? { ...headers, 'x-epm-unlock': token } : headers;
  }

  function graphHeaders(configName, headers = {}) {
    return { ...authHeaders(headers), 'x-epm-config': configName || '' };
  }

  async function apiFetch(url, opts = {}) {
    const r = await fetch(url, {
      ...opts,
      headers: authHeaders(opts.headers || {}),
    });
    if (r.status === 423) clearUnlockToken();
    return r;
  }

  window.EPM_API = { fetch: apiFetch, setUnlockToken, clearUnlockToken };

  // ============ Settings ============

  let settingsCache = null;

  async function loadSettings() {
    try {
      const r = await apiFetch('/api/config');
      if (r.ok) { settingsCache = await r.json(); return settingsCache; }
    } catch {}
    settingsCache = {};
    return settingsCache;
  }

  function getSettings() {
    return {
      configs: settingsCache?.configs || [],
      autoLockMs: settingsCache?.autoLockMs ?? null,
    };
  }

  async function setSettings({ name, renameFrom, tenantId, clientId, clientSecret, policyMap, autoLockMs }) {
    const body = {};
    if (name !== undefined) body.name = name;
    if (renameFrom !== undefined) body.renameFrom = renameFrom;
    if (tenantId !== undefined) body.tenantId = tenantId;
    if (clientId !== undefined) body.clientId = clientId;
    if (clientSecret) body.clientSecret = clientSecret;
    if (policyMap !== undefined) body.policyMap = policyMap;
    if (autoLockMs !== undefined) body.autoLockMs = autoLockMs;
    const r = await apiFetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Failed to save settings');
    await loadSettings();
  }

  async function deleteConfig(name) {
    const r = await apiFetch(`/api/config/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Failed to delete config');
    if (settingsCache?.configs) settingsCache.configs = settingsCache.configs.filter(c => c.name !== name);
  }

  loadSettings();

  // ============ Graph proxy ============

  async function gql(method, graphPath, body, configName) {
    const url = `/api/graph/${graphPath}`;
    const opts = { method, headers: graphHeaders(configName, { 'Content-Type': 'application/json' }) };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    if (method === 'DELETE' && (r.status === 204 || r.status === 200)) return {};
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}: ${t.substring(0, 300)}`);
    }
    if (r.status === 204) return {};
    return r.json();
  }

  // ============ Test connection ============

  async function testConnection(configName) {
    await apiFetch('/api/token/flush', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: configName }),
    });
    const [sc, dc] = await Promise.all([
      gql('GET', `${GRAPH}/configurationPolicies?$top=1&$select=id,name`, null, configName).catch(() => ({ value: [] })),
      gql('GET', `${GRAPH}/deviceConfigurations?$top=1&$select=id,displayName`, null, configName).catch(() => ({ value: [] })),
    ]);
    let orgName = 'Connected';
    let domain = '';
    try {
      const o = await gql('GET', 'v1.0/organization', null, configName);
      const org = o.value?.[0];
      if (org) {
        orgName = org.displayName || 'Connected';
        domain = (org.verifiedDomains || []).find(d => d.isDefault)?.name || '';
      }
    } catch {}
    return { displayName: orgName, domain: domain || 'Intune access verified' };
  }

  // ============ List policies ============

  function matchesPolicyNameFilter(policy, nameFilter) {
    const needle = (nameFilter || '').trim().toLowerCase();
    if (!needle) return true;
    return (policy.name || '').toLowerCase().includes(needle);
  }

  function hasExtensionSetting(node) {
    if (!node || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some(hasExtensionSetting);
    if (typeof node.settingDefinitionId === 'string' && EXTENSION_SETTING_DEFINITION_IDS.has(node.settingDefinitionId)) {
      return true;
    }
    return Object.values(node).some(hasExtensionSetting);
  }

  async function getPolicySettings(policyId, configName) {
    try {
      return await fetchAll(`${GRAPH}/configurationPolicies('${policyId}')/settings?$top=100`, configName);
    } catch {
      return null;
    }
  }

  async function fetchAll(initialPath, configName) {
    const items = [];
    let nextUrl = null;
    const d = await gql('GET', initialPath, null, configName);
    items.push(...(d.value || []));
    nextUrl = d['@odata.nextLink'] || null;
    while (nextUrl) {
      const graphPath = nextUrl.replace('https://graph.microsoft.com/', '');
      const d2 = await gql('GET', graphPath, null, configName);
      items.push(...(d2.value || []));
      nextUrl = d2['@odata.nextLink'] || null;
    }
    return items;
  }

  async function listPolicies({ configName, nameFilter = DEFAULT_POLICY_NAME_FILTER } = {}) {
    const [scAll, dcAll] = await Promise.all([
      fetchAll(`${GRAPH}/configurationPolicies?$select=id,name,platforms,lastModifiedDateTime&$top=100`, configName),
      fetchAll(`${GRAPH}/deviceConfigurations?$select=id,displayName,lastModifiedDateTime&$top=100`, configName),
    ]);

    const policies = [];
    const settingsCatalogPolicies = await Promise.all(scAll.map(async (p) => {
      const settings = await getPolicySettings(p.id, configName);
      const settingsChecked = Array.isArray(settings);
      return {
        id: p.id,
        name: p.name,
        type: 'settingsCatalog',
        platform: 'windows',
        modified: p.lastModifiedDateTime,
        browserExtensionSettings: settingsChecked ? hasExtensionSetting(settings) : false,
        settingsChecked,
      };
    }));
    for (const p of settingsCatalogPolicies) {
      if (p.browserExtensionSettings || matchesPolicyNameFilter(p, nameFilter)) {
        policies.push(p);
      }
    }
    for (const p of dcAll) {
      const t = p['@odata.type'] || '';
      if (t.includes('macOSCustom')) {
        policies.push({ id: p.id, name: p.displayName, type: 'macOSCustom', platform: 'macOS', modified: p.lastModifiedDateTime });
      } else if (t.includes('windows10Custom')) {
        policies.push({ id: p.id, name: p.displayName, type: 'windows10Custom', platform: 'windows', modified: p.lastModifiedDateTime });
      }
    }
    return policies.filter(p => p.browserExtensionSettings || matchesPolicyNameFilter(p, nameFilter));
  }

  // ============ Deploy ============

// Find a settingInstance node whose definitionId contains 'extensionsettings'
  // and the browser keyword — works regardless of exact ID variant (device/user scope).
  function findExtensionSettingNode(node, browser) {
    if (!node || typeof node !== 'object') return null;
    if (typeof node.settingDefinitionId === 'string') {
      const id = node.settingDefinitionId.toLowerCase();
      if (id.includes('extensionsettings') &&
          (browser === 'chrome' ? id.includes('chrome') : id.includes('edge'))) {
        return node;
      }
    }
    const values = Array.isArray(node) ? node : Object.values(node);
    for (const value of values) {
      const found = findExtensionSettingNode(value, browser);
      if (found) return found;
    }
    return null;
  }

  // Find the nearest ancestor node that owns simpleSettingValue within a subtree.
  function findSimpleValueHolder(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.simpleSettingValue) return node;
    const values = Array.isArray(node) ? node : Object.values(node);
    for (const v of values) {
      const found = findSimpleValueHolder(v);
      if (found) return found;
    }
    return null;
  }

  async function deployFile(file, targetPolicyId, { ticketNote, configName } = {}) {
    if (file.os === 'windows') {
      const files = Array.isArray(file.files) && file.files.length > 0 ? file.files : [file];
      return deployWindowsSettingsCatalog(files, targetPolicyId, { ticketNote, configName });
    } else {
      return deployMacOSProfile(file, targetPolicyId, { ticketNote, configName });
    }
  }

  // Windows — Settings Catalog policy with Chrome + Edge ExtensionSettings.
  // PUT replaces the full policy resource — the only Graph API path that accepts settings changes.
  async function deployWindowsSettingsCatalog(files, existingId, { ticketNote, configName } = {}) {
    if (!existingId) throw new Error('No existing Windows Settings Catalog policy mapped');

    const [fullPolicy, currentSettings] = await Promise.all([
      gql('GET', `${GRAPH}/configurationPolicies('${existingId}')`, null, configName).catch(() => null),
      getPolicySettings(existingId, configName),
    ]);
    if (!fullPolicy) throw new Error('Mapped Windows policy was not found');
    if (!Array.isArray(currentSettings)) throw new Error('Could not load Windows policy settings');

    const settingsCopy = JSON.parse(JSON.stringify(currentSettings));

    for (const f of files) {
      const browser = f.filename.includes('Chrome') ? 'chrome' : 'edge';
      const label = browser === 'chrome' ? 'Chrome' : 'Edge';
      let matchedSetting = null;
      let matchedNode = null;
      for (const s of settingsCopy) {
        const node = findExtensionSettingNode(s, browser);
        if (node) { matchedSetting = s; matchedNode = node; break; }
      }
      if (!matchedSetting) {
        throw new Error(`${label} ExtensionSettings not found in mapped Windows policy. Add "Extension management settings" to the Intune policy first.`);
      }
      const valueHolder = findSimpleValueHolder(matchedNode);
      if (!valueHolder) {
        throw new Error(`${label} ExtensionSettings has unsupported shape`);
      }
      valueHolder.simpleSettingValue.value = f.text;
    }

    const { id, createdDateTime, lastModifiedDateTime, settingCount, isAssigned,
            '@odata.context': _ctx, '@odata.etag': _etag, ...policyBody } = fullPolicy;
    if (ticketNote) {
      const cur = policyBody.description || '';
      const ticketLine = cur.match(/Ticket:(.*)$/m);
      if (ticketLine) {
        const existing = ticketLine[1].split(',').map(s => s.trim()).filter(Boolean);
        const toAdd = ticketNote.split(',').map(s => s.trim()).filter(t => !existing.includes(t));
        policyBody.description = cur.replace(/Ticket:.*$/m, `Ticket: ${[...existing, ...toAdd].join(', ')}`);
      } else {
        policyBody.description = cur ? `${cur}\nTicket: ${ticketNote}` : `Ticket: ${ticketNote}`;
      }
    }
    await gql('PUT', `${GRAPH}/configurationPolicies('${existingId}')`, {
      ...policyBody,
      settings: settingsCopy,
    }, configName);

    return {
      status: 'ok',
      id: existingId,
      action: 'updated',
      filesDeployed: files.length,
    };
  }

  // macOS — Custom Profile (deviceConfigurations) — supports PATCH
  async function deployMacOSProfile(file, existingId, { ticketNote, configName } = {}) {
    if (!existingId) throw new Error('No existing macOS custom profile mapped');
    const existing = await gql('GET', `${GRAPH}/deviceConfigurations/${existingId}?$select=id,displayName,description`, null, configName).catch(() => null);
    if (!existing) throw new Error('Mapped macOS profile was not found');
    const b64 = btoa(unescape(encodeURIComponent(file.text)));
    const patch = {
      '@odata.type': '#microsoft.graph.macOSCustomConfiguration',
      displayName: existing.displayName,
      payload: b64,
    };
    if (ticketNote) {
      const cur = existing.description || '';
      const ticketLine = cur.match(/Ticket:(.*)$/m);
      if (ticketLine) {
        const existingTickets = ticketLine[1].split(',').map(s => s.trim()).filter(Boolean);
        const toAdd = ticketNote.split(',').map(s => s.trim()).filter(t => !existingTickets.includes(t));
        patch.description = cur.replace(/Ticket:.*$/m, `Ticket: ${[...existingTickets, ...toAdd].join(', ')}`);
      } else {
        patch.description = cur ? `${cur}\nTicket: ${ticketNote}` : `Ticket: ${ticketNote}`;
      }
    }
    await gql('PATCH', `${GRAPH}/deviceConfigurations/${existingId}`, patch, configName);
    return { status: 'ok', id: existingId, action: 'updated' };
  }

  return {
    DEFAULT_POLICY_NAME_FILTER,
    getSettings,
    setSettings,
    deleteConfig,
    loadSettings,
    testConnection,
    listPolicies,
    deployFile,
  };
})();

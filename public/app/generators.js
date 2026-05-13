// Generators — one entry per extension carries both Chrome + Edge IDs.
// Outputs five policy artefacts:
//   Windows-Allow.json, Windows-Block.json
//   MacOS-Allow-Chrome.mobileconfig, MacOS-Allow-Edge.mobileconfig
//   MacOS-Block-Browser.mobileconfig (combined)
//
// Configuration: window.POLICY_CONFIG can override defaults below before this script runs.

window.GENERATORS = (function(){
  const UPDATE_URL = {
    chrome: 'https://clients2.google.com/service/update2/crx',
    edge:   'https://edge.microsoft.com/extensionwebstorebase/v1/crx'
  };

  // -------- Configuration (overridable via window.POLICY_CONFIG) --------
  const cfg = Object.assign({
    orgDomain:        'com.acme',     // PayloadIdentifier prefix (replace with your org)
    organization:     'IT Department',
    blockedMessage:   'This extension is not approved by IT. Contact the helpdesk to request access.',
    // Distinct UUIDs for allow vs block — same UUID across profiles would collide on macOS.
    // Replace with crypto.randomUUID() output for stronger isolation between deployments.
    uuidChromeAllow:      'A1B2C3D4-E5F6-7890-ABCD-EF1234567890',
    uuidChromeBlock:      'A1B2C3D4-E5F6-7890-ABCD-EF1234567891',
    uuidEdgeAllow:        'B2C3D4E5-F6A7-8901-BCDE-F23456789012',
    uuidEdgeBlock:        'B2C3D4E5-F6A7-8901-BCDE-F12345678901',
    uuidRootChromeAllow:  '11111111-2222-3333-4444-555555555555',
    uuidRootEdgeAllow:    '66666666-7777-8888-9999-AAAAAAAAAAAA',
    uuidRootBlock:        'CCCCCCCC-DDDD-EEEE-FFFF-111111111111',
  }, window.POLICY_CONFIG || {});

  // -------- XML safe-text helper (for any future user-supplied strings) --------
  const xmlEscape = s => String(s == null ? '' : s)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');

  // -------- Windows JSON (Intune Settings Catalog: ExtensionSettings) --------
  // Per-browser: browser = 'chrome' | 'edge'
  function genWindowsAllowJSON(allowlist, browser){
    const obj = { "*": { "installation_mode": "blocked" } };
    allowlist.forEach(e => {
      const id = e[browser+'Id'];
      if (!id) return;
      const entry = { installation_mode: e.mode };
      if (e.mode === 'force_installed') entry.update_url = UPDATE_URL[browser];
      obj[id] = entry;
    });
    return JSON.stringify(obj, null, 2);
  }

  function genWindowsBlockJSON(blocklist, browser){
    const obj = {};
    blocklist.forEach(e => {
      const id = e[browser+'Id'];
      if (id) obj[id] = { installation_mode: "removed" };
    });
    return JSON.stringify(obj, null, 2);
  }

  // -------- macOS .mobileconfig (combined Chrome + Edge allowlist) --------
  function genMacAllowMobileconfig(allowlist){
    let chromeDict = '', edgeDict = '';
    allowlist.forEach(e => {
      for (const browser of ['chrome', 'edge']) {
        const id = e[browser + 'Id'];
        if (!id) continue;
        let inner = `\t\t\t\t<key>installation_mode</key>\n\t\t\t\t<string>${e.mode}</string>`;
        if (e.mode === 'force_installed') {
          inner += `\n\t\t\t\t<key>update_url</key>\n\t\t\t\t<string>${UPDATE_URL[browser]}</string>`;
        }
        const entry = `\t\t\t<key>${id}</key>\n\t\t\t<dict>\n${inner}\n\t\t\t</dict>\n`;
        if (browser === 'chrome') chromeDict += entry;
        else edgeDict += entry;
      }
    });

    const makeAllow = (type, uuid, id, name, dict) => `\t\t<dict>
\t\t\t<key>PayloadType</key>
\t\t\t<string>${type}</string>
\t\t\t<key>PayloadVersion</key>
\t\t\t<integer>1</integer>
\t\t\t<key>PayloadIdentifier</key>
\t\t\t<string>${id}</string>
\t\t\t<key>PayloadUUID</key>
\t\t\t<string>${uuid}</string>
\t\t\t<key>PayloadDisplayName</key>
\t\t\t<string>${name}</string>
\t\t\t<key>PayloadEnabled</key>
\t\t\t<true/>
\t\t\t<key>ExtensionSettings</key>
\t\t\t<dict>
\t\t\t\t<key>*</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>installation_mode</key>
\t\t\t\t\t<string>blocked</string>
\t\t\t\t\t<key>blocked_install_message</key>
\t\t\t\t\t<string>${xmlEscape(cfg.blockedMessage)}</string>
\t\t\t\t</dict>
${dict}\t\t\t</dict>
\t\t</dict>`;

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>PayloadContent</key>
\t<array>
${makeAllow('com.google.Chrome', cfg.uuidChromeAllow, `${cfg.orgDomain}.chrome.allow`, 'Chrome Extension Allowlist', chromeDict)}
${makeAllow('com.microsoft.Edge', cfg.uuidEdgeAllow, `${cfg.orgDomain}.edge.allow`, 'Edge Extension Allowlist', edgeDict)}
\t</array>
\t<key>PayloadDescription</key>
\t<string>Blocks all extensions except explicitly allowed ones.</string>
\t<key>PayloadDisplayName</key>
\t<string>Browser Extension Allowlist Policy</string>
\t<key>PayloadIdentifier</key>
\t<string>${cfg.orgDomain}.browser.extension.allowlist</string>
\t<key>PayloadOrganization</key>
\t<string>${xmlEscape(cfg.organization)}</string>
\t<key>PayloadType</key>
\t<string>Configuration</string>
\t<key>PayloadUUID</key>
\t<string>${cfg.uuidRootChromeAllow}</string>
\t<key>PayloadVersion</key>
\t<integer>1</integer>
</dict>
</plist>`;
  }

  // -------- macOS .mobileconfig (combined Chrome + Edge blocklist) --------
  function genMacBlockMobileconfig(blocklist){
    let chromeDict = '', edgeDict = '';
    blocklist.forEach(e => {
      const entry = (id) => `\t\t\t<key>${id}</key>\n\t\t\t<dict>\n\t\t\t\t<key>installation_mode</key>\n\t\t\t\t<string>removed</string>\n\t\t\t</dict>\n`;
      if (e.chromeId) chromeDict += entry(e.chromeId);
      if (e.edgeId)   edgeDict   += entry(e.edgeId);
    });

    const makeBlock = (type, uuid, id, name, dict) => `\t\t<dict>
\t\t\t<key>PayloadType</key>
\t\t\t<string>${type}</string>
\t\t\t<key>PayloadVersion</key>
\t\t\t<integer>1</integer>
\t\t\t<key>PayloadIdentifier</key>
\t\t\t<string>${id}</string>
\t\t\t<key>PayloadUUID</key>
\t\t\t<string>${uuid}</string>
\t\t\t<key>PayloadDisplayName</key>
\t\t\t<string>${name}</string>
\t\t\t<key>PayloadEnabled</key>
\t\t\t<true/>
\t\t\t<key>ExtensionSettings</key>
\t\t\t<dict>
${dict}\t\t\t</dict>
\t\t</dict>`;

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>PayloadContent</key>
\t<array>
${makeBlock('com.google.Chrome', cfg.uuidChromeBlock, `${cfg.orgDomain}.chrome.block`, 'Chrome Extension Blocklist', chromeDict)}
${makeBlock('com.microsoft.Edge', cfg.uuidEdgeBlock, `${cfg.orgDomain}.edge.block`, 'Edge Extension Blocklist', edgeDict)}
\t</array>
\t<key>PayloadDescription</key>
\t<string>Removes specific browser extensions across Chrome and Edge.</string>
\t<key>PayloadDisplayName</key>
\t<string>Browser Extension Blocklist Policy</string>
\t<key>PayloadIdentifier</key>
\t<string>${cfg.orgDomain}.browser.extension.blocklist</string>
\t<key>PayloadOrganization</key>
\t<string>${xmlEscape(cfg.organization)}</string>
\t<key>PayloadType</key>
\t<string>Configuration</string>
\t<key>PayloadUUID</key>
\t<string>${cfg.uuidRootBlock}</string>
\t<key>PayloadVersion</key>
\t<integer>1</integer>
</dict>
</plist>`;
  }

  return {
    genWindowsAllowJSON, genWindowsBlockJSON,
    genMacAllowMobileconfig, genMacBlockMobileconfig,
    xmlEscape,  // exposed for callers that need it
    config: cfg,
  };
})();

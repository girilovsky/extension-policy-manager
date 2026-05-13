<div align="center">

<img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=flat-square&logo=node.js" alt="Node">
<img src="https://img.shields.io/badge/docker-ready-2496ED?style=flat-square&logo=docker" alt="Docker">
<img src="https://img.shields.io/badge/Microsoft_Intune-0078D4?style=flat-square&logo=microsoft" alt="Intune">
<img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License">

# Extension Policy Manager

**Self-hosted web app for managing browser extension policies across Chrome and Edge — with one-click deployment to Microsoft Intune.**

</div>

---

## Overview

Extension Policy Manager is an internal IT tool that centralises control over which browser extensions are allowed or blocked in your organisation. You maintain a single source of truth — one list per environment — and EPM handles policy generation and Intune deployment across all platforms automatically.

No build step. No framework sprawl. Run it locally or drop it in a container in two minutes.

---

## Features

### 🗂 Extension management
- Separate **allowlist** and **blocklist** with support for both Chrome and Edge IDs
- Add by store URL or raw 32-character extension ID
- Automatic name lookup from the Chrome Web Store / Edge Add-ons page
- **Bulk identify** — fill in names for an entire imported ID list at once
- Near-duplicate detection with one-click merge proposals

### ⚙️ Policy generation
| Platform | Format |
|---|---|
| Windows | Settings Catalog JSON (`ExtensionSettings` for Chrome + Edge) |
| macOS | `.mobileconfig` profiles via Managed Preferences payload |

### 🚀 Intune deployment
- Authenticate with an Azure app registration (client credentials flow)
- Auto-maps each policy type to the right existing Intune policy, or creates a new one
- Preserves group assignments when updating (delete → recreate → re-assign)
- Multiple named configurations for multi-tenant or multi-environment setups
- Per-config token cache with automatic refresh before expiry

### 📥 Import
- Import existing Intune JSON exports or `.mobileconfig` files to bootstrap your list
- Auto-detects file format — combined profiles populate both Chrome and Edge slots from one file
- Post-import auto-identify: fetches names and suggests merges at a lower similarity threshold

### 🕓 History & rollback
- Every save records a structured diff (added / removed per list) and an optional ticket reference
- Browse the full snapshot for any past state
- One-click rollback (requires unlock if a settings password is configured)

### 🔒 Security
- Client secret encrypted at rest with **AES-256-GCM**
- Settings password protected with **PBKDF2 / SHA-256** (100 000 iterations)
- Configurable auto-lock timeout; unlock tokens are HMAC-signed and expire after 12 hours
- Token cache is per-config and flushed automatically on credential change

---

## Quick start

### Node.js

```bash
npm install
node server.js
```

Open **http://localhost:8080**

### Docker Compose

```bash
docker compose up -d
```

Data is persisted in the `epm-data` named volume. The `public/` directory is mounted read-only so you can update the frontend without rebuilding the image.

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `DATA_DIR` | `./data` | Path for `extensions.json`, `config.json`, `history.json` |
| `EPM_SECRET_KEY` | *(derived from a hardcoded string)* | 32-byte key for AES-256-GCM encryption and HMAC signing. **Always set this in production.** |

---

## Intune setup

1. In **Entra ID → App registrations**, create a new registration.
2. Under **API permissions**, add `DeviceManagementConfiguration.ReadWrite.All` (Application) and grant admin consent.
3. Generate a **Client secret**.
4. In EPM → **Settings → Intune**, enter your Tenant ID, Client ID, and Client Secret.
5. Go to **Deploy**, confirm the policy mapping, and click **Deploy**.

---

## Policy structure

EPM generates five policy artefacts from a single extension list.

### Windows — Settings Catalog JSON

Two JSON files are produced (one per browser — Chrome and Edge), structured as Intune `ExtensionSettings` objects. Each file is ready to paste into a Settings Catalog policy under **Computer Configuration → Microsoft Edge / Google Chrome → Extensions → Extension management settings**.

**Allowlist logic** — all extensions are blocked by default (`"*": { "installation_mode": "blocked" }`). Each explicitly allowed extension is set to `allowed` or `force_installed`:

```json
{
  "*": { "installation_mode": "blocked" },
  "nngceckbapebfimnlniiiahkandclblb": { "installation_mode": "allowed" },
  "echcggldkblhodogklpincgchnpgcdco": {
    "installation_mode": "force_installed",
    "update_url": "https://clients2.google.com/service/update2/crx"
  }
}
```

**Blocklist logic** — only the listed extensions are marked `removed`. All others remain unaffected (use alongside an allowlist policy, or standalone):

```json
{
  "cjpalhdlnbpafiamejdnhcphjbkeiagm": { "installation_mode": "removed" }
}
```

### macOS — `.mobileconfig` profiles

Two `.mobileconfig` files are produced:

| File | Contents |
|---|---|
| `MacOS-Allow.mobileconfig` | Chrome + Edge `ExtensionSettings` allowlist in a single profile |
| `MacOS-Block.mobileconfig` | Chrome + Edge `ExtensionSettings` blocklist in a single profile |

Each profile uses the `com.google.Chrome` and `com.microsoft.Edge` Managed Preferences payload types. Deploy via Intune → **macOS → Configuration profiles → Custom** (upload the `.mobileconfig` directly).

### Customising the macOS profile

Add a `window.POLICY_CONFIG` block to `public/index.html` **before** the other scripts to override the defaults baked into `generators.js`:

```html
<script>
window.POLICY_CONFIG = {
  orgDomain:      'com.example',       // PayloadIdentifier prefix
  organization:   'Example Corp IT',
  blockedMessage: 'Contact helpdesk to request an extension.',
  // Optional: replace with crypto.randomUUID() output for production deployments
  uuidChromeAllow:     'YOUR-UUID-HERE',
  uuidEdgeAllow:       'YOUR-UUID-HERE',
  uuidChromeBlock:     'YOUR-UUID-HERE',
  uuidEdgeBlock:       'YOUR-UUID-HERE',
  uuidRootChromeAllow: 'YOUR-UUID-HERE',
  uuidRootEdgeAllow:   'YOUR-UUID-HERE',
  uuidRootBlock:       'YOUR-UUID-HERE',
};
</script>
```

> **Note:** UUIDs must be unique per profile. Reusing a UUID across different profiles on the same device will cause macOS to treat them as the same payload and silently overwrite one.

---

## PowerShell alternative

`Deploy-ExtensionPolicies.ps1` is a standalone script that deploys exported policy files directly from the command line — no web UI required. Useful for CI/CD or air-gapped environments.

```powershell
# Deploy everything
.\Deploy-ExtensionPolicies.ps1 -ConfigPath .\export

# Dry run
.\Deploy-ExtensionPolicies.ps1 -ConfigPath .\export -WhatIf

# Skip macOS profiles
.\Deploy-ExtensionPolicies.ps1 -ConfigPath .\export -SkipMacOS
```

---

## Project structure

```
server.js                      Express API server + static file serving
public/
  index.html                   App shell (React loaded via CDN, no build step)
  app/
    app.jsx                    Main React application
    ui.jsx                     Shared components and icon library
    styles.css                 All styles — CSS custom properties, dark mode
    generators.js              Policy generators (Settings Catalog JSON + mobileconfig)
    parsers.js                 Import parsers (Intune JSON export + mobileconfig)
    intune.js                  Microsoft Graph API client (browser-side)
    data.js                    Built-in extension name/ID reference data
data/                          Runtime data directory (auto-created)
  extensions.json              Current allowlist + blocklist
  config.json                  Intune credentials (secret encrypted at rest)
  history.json                 Change history with full snapshots
Dockerfile
docker-compose.yml
Deploy-ExtensionPolicies.ps1   Standalone PowerShell deployment script
```

---

## Tech stack

- **Backend** — Node.js 18+, Express 4, native `node:crypto` (no third-party auth libraries)
- **Frontend** — React 18 (UMD), Babel Standalone, plain CSS (no bundler)
- **Fonts** — [Geist](https://vercel.com/font) + [JetBrains Mono](https://www.jetbrains.com/lp/mono/) via Google Fonts
- **Intune** — Microsoft Graph API `beta` endpoint

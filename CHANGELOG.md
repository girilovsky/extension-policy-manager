# CHANGELOG — Code Review Fixes

## Summary

Applied all fixes from the code review report. Total: 1 critical (P0), 2 serious (P1), 4 moderate (P2), 5 minor (P3) issues resolved.

---

## generators.js — fully rewritten

- **[P0] Fixed duplicate PayloadUUID** — Chrome allow profile and Chrome block profile no longer share `A1B2C3D4-E5F6-7890-ABCD-EF1234567890`. Block now uses `...EF1234567891`.
- **[P1] Parameterized all config** — UUIDs, org domain, organization name, blocked_install_message are now overridable via `window.POLICY_CONFIG = { ... }` set before generators.js loads.
- **[P1] Consistent PayloadIdentifier scheme** — replaced mixed `com.company.*` / `com.smart.*` with `${cfg.orgDomain}.*` everywhere (defaults to `com.acme`).
- **[P3] Added `xmlEscape` helper** — all user-configurable strings (blocked message, organization) are now XML-escaped in mobileconfig output.

## app.jsx — patched in-place (~15 changes)

- **[P1] Feature flags** — `window.__features = { networkLookup, claudeLookup }` controls which lookup backends are available. Standalone HTML sets both to `false`.
- **[P1] Graceful `window.claude.complete` fallback** — ListRow lookup now tries `r.jina.ai` first (same as bulk identify), falls back to Claude API only if available. Shows clear toast instead of crashing with TypeError.
- **[P1] AddRow lookup** — checks `window.__features.networkLookup` before calling; returns clear toast when unavailable.
- **[P1] UI buttons hidden** — "Identify all", "Re-identify & merge", "Find name" (ListRow), sparkle button (AddRow) are all hidden when the relevant lookup backend is unavailable.
- **[P2] Race condition fixed** — `identifyToken` ref + `isCancelled()` check inside the identify loop. Switching section now increments the token and resets `identifying` / `identifyProgress` / `mergeProposals`.
- **[P2] Merged two `setData` into one** — proposals are now computed inside the same updater that performs merges, eliminating the anti-pattern of calling `setMergeProposals` inside a `setData` updater.
- **[P2] AbortController + timeout** — `lookupExtension` fetch now has 8s timeout via AbortController; HTTP 429 is caught and surfaced as "rate-limited" in toast and summary.
- **[P3] Stable `keyOf`** — removed `idx` from the composite key; now `chromeId::edgeId` only.
- **[P3] `MERGE_SIMILARITY_THRESHOLD`** constant (0.7) replaces magic number.
- **[P3] `LOOKUP_TIMEOUT_MS`** constant (8000) replaces inline value.
- **[P3] `parseSmart` memoized** via `useMemo`.
- **[P3] `aria-label`** added to search input.

## app.standalone.jsx — deleted

- All standalone-specific logic is now handled by feature flags in the unified `app.jsx`.

## Extension Policy Manager (standalone source).html — updated

- Injects `window.__features = { networkLookup: false, claudeLookup: false }` before app scripts load.
- Now references `app/app.jsx` instead of the deleted `app/app.standalone.jsx`.

## Extension Policy Manager (standalone).html — NOT updated

- This is a pre-built 1.4 MB bundle with inlined resources. It was NOT regenerated; a build pipeline is needed to rebuild it from the updated sources.

## Files unchanged

- `app/data.js` — all 60 extension IDs validated; no changes needed.
- `app/styles.css` — import-related styles added at the end.
- `uploads/` — reference files, untouched.

## NEW FEATURE: Import old configs

### app/parsers.js (new file, 120 lines)

- Auto-detects JSON vs mobileconfig from filename/content
- **JSON parser:** extracts `{id, mode}` entries from Intune Settings Catalog `ExtensionSettings` format; skips `"*"` wildcard and non-`[a-p]{32}` keys
- **Mobileconfig parser:** parses plist XML via DOMParser → walks `PayloadContent` array → detects `com.google.Chrome` vs `com.microsoft.Edge` via `PayloadType` → extracts extension IDs from `ExtensionSettings` dict
- Combined profiles (e.g. block config with both Chrome+Edge) auto-fill both import slots from one file

### app/app.jsx — Import feature additions

- **Import tab** added to tab bar alongside "Extensions" and "Policy output"
- **`ImportView` component:** two side-by-side drop zones (Chrome + Edge), drag-and-drop + click-to-browse, file format auto-detection, preview with entry counts
- **Both browsers required:** import button disabled until both Chrome and Edge configs are provided; info banner shows which one is missing
- **`handleImport` function:** builds unified entry list from both configs, replaces all existing data for the active section (allowlist/blocklist)
- **Auto-identify + merge at 30%:** after import, `identifyAllUnknown(0.3)` runs automatically via `importTrigger` state + useEffect; names are fetched via r.jina.ai, then merge proposals computed at ≥30% similarity
- **`identifyAllUnknown` now accepts threshold parameter** and works even without network (skips identification, still computes merge proposals from existing names)

### app/ui.jsx — New icons

- Added: `Icon.Upload`, `Icon.AlertTriangle`, `Icon.File`

### app/styles.css — Import styles

- Added `.import-view`, `.import-warning`, `.import-missing`, `.import-slots`, `.import-slot` (with `--empty`, `--filled`, `--dragover`, `--chrome`, `--edge` variants), `.import-actions`, `.import-summary`
- Responsive: import slots stack vertically on narrow screens

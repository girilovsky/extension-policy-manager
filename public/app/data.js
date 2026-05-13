// Unified extension data — one entry per extension with both Chrome and Edge IDs.
// Populated automatically as you add extensions via the UI.
// You can also pre-populate this file manually using the format below.
//
// mode values:
//   "allowed"         — extension is explicitly allowed
//   "blocked"         — extension is explicitly blocked
//   "force_installed" — extension is silently installed and cannot be removed
//
// Example entry:
//   { name: "uBlock Origin", chromeId: "cjpalhdlnbpafiamejdnhcphjbkeiagm", edgeId: "odfafepnkmbhccpbejgmmehpkigpeaji", mode: "allowed" }

window.INITIAL_DATA = {
  allowlist: [],
  blocklist: [],
};

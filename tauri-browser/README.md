# Kessel (v0.6)

A real, working custom browser: tabs (each backed by its own native
webview) that are properly destroyed on close and idle-discarded to save
memory, a redesigned dark/light/custom-theme UI with an Opera-GX-style
icon rail and slide-out side panel, a built-in ad/tracker blocker, a
local encrypted password manager with master-password + TOTP two-factor
unlock and login-form autofill, downloads, bookmarks, history, and a
fully rebuilt settings page. Built with Tauri 2 (Rust) + vanilla JS ES
modules — no bundler, using Tauri's injected `window.__TAURI__` global
directly.

This is a substantial rewrite of the v0.2 base. Every Rust command in
`src-tauri/src/` and every frontend page in `src/` was compiled and
syntax-checked against this machine's pinned toolchain while writing it
(see **Run it** below for the exact command) — `cargo build` finishes
clean with zero warnings. That derisks the usual "written blind, fix on
first real compile" gap significantly, but a GUI app still can't be fully
exercised by a headless check — if something in the actual running window
looks off, that's the next thing to iterate on.

## Liquid Glass (unreleased, on top of v0.6)
**Not compiled yet** — unlike the rest of this README's claims, the Rust
half of this change was written on a machine without the Rust/MSVC
toolchain. The frontend was checked in a Chromium preview with a mocked
`window.__TAURI__`; run `cargo build` before trusting the Rust side.

- **iOS 26-style Liquid Glass UI** (Settings → Appearance, on by default):
  the tab strip, nav bar, bookmarks bar and rail become floating glass
  capsules over a wallpaper — blur + saturation, a specular rim, and real
  edge **refraction** via an SVG displacement filter in `backdrop-filter`
  (WebView2/Chromium supports this). Styles live in `src/shared/glass.css`,
  scoped to `html.glass`, so switching it off restores the solid theme.
- **Wallpapers**: five built-in gradient presets or your own image
  (downscaled to ≤2560px JPEG and kept in the pages' shared localStorage,
  not settings.json). The new-tab page paints the same wallpaper offset by
  the chrome size so toolbar + new tab read as one continuous background.
- **iOS-style squircle site icons** on the rail, bookmarks bar and new-tab
  page: the site's own `apple-touch-icon.png` (the iOS home-screen icon),
  then its favicon, then the favicon a tab reported when you visited it,
  else a colored letter tile.
- **Redesigned new-tab page**: lock-screen clock, glass search capsule,
  Speed Dial + Bookmarks as app-icon grids on glass panels.
- **Bookmarks bar** under the omnibox (toggle in Appearance). Click opens
  in the current tab, middle/Ctrl-click in a new one.
- **Frameless window**: the tab strip is the title bar (drag empty space,
  double-click to maximize) with its own minimize/maximize/close. Those
  window permissions are granted only to the toolbar webview
  (`capabilities/toolbar-window.json`), never to tab content.
- `TOOLBAR_HEIGHT` / `RAIL_WIDTH` are gone: the toolbar measures its real
  chrome and reports it via the new `set_chrome_insets` command, so any
  CSS/layout change positions tabs correctly without touching Rust.
- `add_bookmark` / `remove_bookmark` now broadcast `bookmarks-changed`.
- **Glass text adapts to the wallpaper, not the theme**: white text over
  dark backdrops, dark over light ones. Your own image's brightness is
  measured separately behind the toolbar (top/left edges) and behind the
  new-tab page (centre), like iOS does.
- **Tear-off pop-out windows**: drag a tab below the toolbar or out of the
  window and it *moves* into its own floating window; drag a pinned site
  off the rail to open a copy. Each pop-out has a glass title bar with keep
  on top, back to tabs (`dock_popout`), minimize/maximize/close. Closing the
  main window closes them too.

## What's new in v0.6
- **The left rail and side panel are now Opera-GX-style**, replacing the
  v0.5 detachable floating-window control panel:
  - A slim, always-visible icon rail (pinned sites, ad-block shield,
    downloads, passwords, settings) is back in the main window's own
    layout, not a separate OS window.
  - Clicking a rail icon **slides a panel out from the rail**, right
    beside your active tab, showing that icon's actual content live — a
    pinned site's real page, or the Downloads/Passwords/Settings page.
    It's a genuine second webview (`toggle_side_panel` in
    `src-tauri/src/main.rs`), not a popup or an iframe.
  - The active tab is **pushed right to make room**, not covered — you
    see both the panel and your page at the same time, which was the
    actual point.
  - **Drag the panel's right edge to resize it** (260–560px, remembered
    across restarts). Clicking the same rail icon again closes the panel;
    clicking a different one swaps what's showing.
  - Settings and Passwords gained a small responsive tweak so they lay
    out sanely at panel width, not just full-tab width (their sidebar
    nav collapses to a horizontal strip below ~620/460px).
  - The shield icon is a direct on/off toggle, not a panel — clicking it
    doesn't slide anything out.

## What's new in v0.4
- **Idle tab discarding** (Settings → Performance): a background tab's
  webview is destroyed after sitting idle past a configurable number of
  minutes (default 10, 0 = never), and silently recreated — reloading the
  page — if you switch back to it. Session-restored tabs go further:
  only the one you were last looking at gets a real webview on launch,
  the rest come back as zero-cost placeholders until clicked. Neither
  checks whether a tab is playing audio/video before discarding it.
- **Password autofill**: a small "fill saved password" chip appears near
  a detected login field when there's a saved credential for that page.
  Nothing fills without you clicking it. The match is decided entirely by
  Rust reading the webview's own real, current URL server-side — never
  from a value the page's JS supplies — so a look-alike domain can't
  successfully ask for credentials belonging to the real one. Toggle it
  off in Settings → Passwords.
- **Real favicons** in the tab strip, reported back from each page's
  `<link rel="icon">` (falling back to `/favicon.ico`), replacing the
  first-letter avatar. Falls back automatically if the icon 404s.
- **Drag-to-reorder tabs**, and a right-click tab context menu (duplicate,
  close, close others, pin).
- **Recently-closed tabs list** in Settings → History — browse and reopen
  any of the last 20, not just blindly the most recent
  (Ctrl/Cmd+Shift+T still does that).
- **Per-site zoom** is now remembered (via that page's own `localStorage`,
  so it's genuinely per-site with no backend involved) instead of
  resetting on every visit.
- Fixed a real off-by-16px layout bug where the content webview clipped
  the bottom few pixels of the address bar's rounded corners.
- Fixed duplicate Settings/Passwords tabs: opening either now focuses the
  one already-open tab (a new Rust-side singleton-tab registry) instead
  of spawning another full webview every time.

## What's new in v0.3
- **Tabs are actually destroyed on close.** `close_tab` now calls
  `Webview::close()` (confirmed available in the pinned Tauri 2.11.5) —
  the old "park off-screen and drop the reference" leak is gone. Inactive
  *but still open* tabs are still parked off-screen when you switch away
  from them (proven-reliable technique, unrelated to the leak).
- **Redesigned UI**: dark / light / fully-custom theme (your own
  background, surface, and text colors), 8 accent-color presets plus a
  custom color picker, adjustable interface scale, a reduce-motion
  toggle, and a consistent component system (buttons, toggles, modals,
  cards) shared by every page via `src/shared/theme.css`. Icons are
  inline SVG (`src/shared/icons.js`) — no icon font, nothing to fetch.
- **Left control panel**: pin any site for one-click access, right next
  to the ad-blocker shield (with a live blocked-count badge), downloads,
  the password manager, and settings.
- **Ad & tracker blocker**: an expanded built-in list (150+ domains)
  blocked at the navigation level, plus your own custom block list and an
  allow-list for sites you want to exempt, all editable from Settings →
  Privacy & Security. Cosmetic ad-hiding still runs inside every page.
- **Password manager** (`kessel://passwords`): a single vault file
  encrypted with AES-256-GCM, keyed by Argon2id from your master
  password (which is never itself stored). Optional TOTP two-factor
  confirmation on unlock (works with Google Authenticator, 1Password,
  Authy, etc. — enter the shown secret manually, no QR renderer here).
  Built-in password generator, auto-lock after N idle minutes.
- **Real downloads**: files save to your OS Downloads folder (de-duped
  filenames), tracked with progress/success state, viewable from the
  rail's downloads popover or Settings → Downloads, with "open file" /
  "open folder" actions.
- **Real tab titles**: each page's actual `document.title` is reported
  back and kept live via a `MutationObserver`, replacing the old
  "title is just the URL" placeholder.
- **Real loading progress**: driven by Tauri's `on_page_load`
  Started/Finished events instead of a fixed-duration animation guess.
- **Session restore** (optional, in Settings → Search & Startup): reopen
  your last session's tabs instead of a fresh one.
- **Rewritten settings page**: sectioned nav (Appearance, Search &
  Startup, Privacy & Security, Pinned Sites, Bookmarks, History,
  Downloads, Passwords, About) instead of one flat list.

## What still works from v0.2
- Address bar (now a single omnibox that both searches and navigates)
  that tracks in-page navigation, including clicks inside the page.
- Back / forward / reload, wired to the active tab.
- Popup blocking, working zoom controls (Ctrl/Cmd + `+`/`-`/`0`).
- Search engine picker (Google / Bing / DuckDuckGo / Brave / Ecosia /
  Startpage), remembered and used as the omnibox's "not a URL" fallback.
- The full shortcut set, including ones that work from *inside* a loaded
  page (injected per-tab), not just the toolbar:
  - Middle-click / Ctrl-click a link → open in a new background tab
  - Middle-click a tab → close it
  - Ctrl/Cmd+Tab / Ctrl/Cmd+Shift+Tab → cycle tabs
  - Ctrl/Cmd+1..8 → jump to that tab; Ctrl/Cmd+9 → last tab
  - Ctrl/Cmd+Shift+T → reopen the most recently closed tab (up to 20)
  - Ctrl/Cmd+Shift+L → open the password manager
  - Alt+Left / Alt+Right → back / forward; F5 / Ctrl/Cmd+R → reload
  - Ctrl/Cmd+T / W / L / D → new tab / close tab / focus address bar /
    bookmark (these four are toolbar-only, since e.g. "focus the address
    bar" isn't meaningful from inside a page)
- Bookmarks and history, persisted to JSON in the OS app-data directory.

## Known limitations (honest, not hidden)
- **Ad blocking can't intercept sub-resource network requests** on
  external sites — Tauri's per-request interception hook
  (`on_web_resource_request`) is documented as not working for external
  sites, only the app's own bundled pages. So this is domain-navigation
  blocking (built-in list + your custom list) plus cosmetic hiding, not
  the same mechanism a browser-extension blocker like uBlock Origin uses.
- **The password vault trusts the OS user account it runs under** — it
  protects saved credentials from casual disk access and other apps, via
  real authenticated encryption, not from a compromised OS or a
  keylogger while the vault is unlocked. No local-only vault can do that.
- **Every page can technically call this app's Rust commands** — since
  `withGlobalTauri` exposes `window.__TAURI__` to every webview (needed
  for the shortcuts/link-handling to work from inside pages), a malicious
  website could in theory also call those same commands. Low risk for a
  personal project used by one person; a production browser would need
  tighter per-webview command scoping. Autofill's match-lookup command is
  hardened against the specific worst case this enables (a page can't
  spoof which site it is — see `vault_autofill_match` in `main.rs`), but
  a page can still ask "is there a saved credential for the site I'm
  actually on" and get a yes/no, an inherent property of doing autofill
  detection in page-reachable JS at all, not something this toggle-off
  setting fully closes on its own.
- **Idle tab discarding doesn't know about audio/video** — a tab quietly
  playing music can still be discarded and interrupted if it's not the
  active tab. Turn the timeout to 0 in Settings → Performance if that's
  a problem for how you use it.
- **The side panel isn't a tab** — it doesn't appear in the tab strip,
  isn't included in session restore, and closing it just hides it rather
  than adding to the recently-closed list. That's deliberate (it mirrors
  Opera GX's own behavior), but worth knowing if you go looking for it
  in those places.
- **The side panel's resize handle is a thin 6px sliver** at its right
  edge (deliberately left uncovered by the panel's own webview so it can
  receive mouse events at all — see the comment on
  `SIDE_PANEL_RESIZE_HANDLE_WIDTH` in `main.rs`). It can be a little
  fiddly to grab precisely; hovering shows an accent highlight to help
  find it.
- **Typing `kessel://...` into the omnibox on an existing tab opens a new
  tab** rather than replacing the current page — deliberate, to avoid
  guessing a platform-specific internal asset URL for an already-loaded
  external webview; matches how the rail buttons already behave.
- Back/forward buttons don't disable themselves at the real ends of
  history (Tauri doesn't expose a content webview's history length) —
  clicking them past the end is just a no-op.
- No true OS-wide global shortcuts (`tauri-plugin-global-shortcut` was
  deliberately left out, one less native dependency to compile).

## Requirements
- Rust (stable) + Node.js 18+
- Windows: WebView2 (usually preinstalled) + MSVC Build Tools with the
  Desktop C++ workload. If you hit a `C2894`/`type_traits` compiler error
  from `cl.exe`, it's a known MSVC-toolset/Windows-SDK version mismatch —
  build from an environment pinned to an older Windows SDK, e.g.:
  ```bash
  call "<path to>\VC\Auxiliary\Build\vcvarsall.bat" amd64 10.0.19041.0
  ```
  (see `kessel-dev.bat` at the repo root, which does exactly this.)
- macOS: Xcode command line tools (WebKit is built in)
- Linux: `webkit2gtk`

## Run it
```bash
npm install
npm run dev
```
On Windows, launch via `kessel-dev.bat` first if you hit the MSVC/SDK
compiler error above — it loads the pinned build environment, then drops
you at a prompt to run `npm run dev` yourself.

## Build an installer
```bash
npm run build
```
Output in `src-tauri/target/release/bundle/`.

## Project layout
```
src-tauri/src/
  main.rs     window + tab lifecycle + side-panel lifecycle, all commands
  adblock.rs  the blocked-domain list + the per-tab injected content script
  store.rs    settings/history/bookmarks/pinned-sites/downloads persistence
  vault.rs    the password manager: Argon2id + AES-256-GCM + TOTP
src/
  index.html / main.js / style.css   toolbar: icon rail + tab strip + omnibox
  newtab.html / newtab.js            new-tab page
  settings.html / settings.js        settings (sectioned)
  passwords.html / passwords.js      password manager UI
  downloads.html / downloads.js      downloads list (shown in the side panel)
  shared/theme.css                   design tokens + shared components
  shared/theme.js                    applies + live-syncs appearance settings
  shared/glass.css / glass.js        Liquid Glass material, wallpapers, refraction, site icons
  shared/icons.js                    inline SVG icon set
  shared/api.js                      search engines, URL heuristics, toast
```

## Natural next steps
- True per-tab history length (enable/disable back/forward correctly)
- Sub-resource ad blocking via a request-interception hook, if/when
  Tauri's hook gets external-site support
- Global keyboard shortcuts via `tauri-plugin-global-shortcut`
- Vault import/export, and per-item TOTP codes for 2FA-protected sites
- Editable/renameable bookmarks, bookmark folders
- Auto-hide the control panel when the main window is minimized

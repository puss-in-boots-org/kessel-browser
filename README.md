# Kessel

**A light Windows browser with the features of Opera GX, built-in
blocking in the style of Brave, and the looks to match.** Kessel is built with Tauri 2
(Rust) and vanilla JavaScript on Microsoft's WebView2, the Chromium engine
already on every Windows 10 and 11 PC. It doesn't bundle a second copy of
Chromium, and its tabs sleep when you're not using them.

Everything stays on your PC: there's no Kessel account and no Kessel
server. Your passwords are in an encrypted vault, and the safe-browsing
lists are checked locally.

- **Download:** [latest release](https://github.com/puss-in-boots-org/kessel-browser/releases/latest).
  It has the Windows installer (`.exe`), an `.msi`, and the Android app.
  The installers aren't code-signed yet, so Windows SmartScreen will ask
  before running them.
- **Build it yourself:** see [`tauri-browser/README.md`](tauri-browser/README.md).
- **What's done and what's next:** [`FEATURES.md`](FEATURES.md) tracks
  more than 1,000 browser features, one row each.

## What Kessel offers

### Light by design
- Tabs have a lifecycle: shown, then hidden (throttled), then paused, then
  asleep with their webview closed. You choose how many stay awake and
  which sites never sleep. Tabs playing sound are never put to sleep.
- After a restart, only the tab you were looking at loads. The others
  wait until you click them.
- Hover cards and tab search show each tab's memory and CPU use. A tab
  using more than 1.5 GB gets an orange ring.
- `scripts/kessel-memory.ps1` adds up Kessel's real memory use, WebView2's
  processes included.

### Tabs, windows and workspaces
- Tab groups: named, coloured, foldable, made automatically by site, and
  saved to the bookmarks bar to reopen after a restart.
- Vertical or horizontal tabs, a strip that scrolls, pinned and muted tabs,
  and picking several tabs with Ctrl+click or Shift+click.
- Tab search (Ctrl+Shift+A) across every window, sleeping and recently
  closed tabs included. Hover cards show a preview of the page.
- Drag tabs between windows, tear a tab off into its own pop-out window,
  or drop a tab on the page's edge for **split view**.
- Drag a Chrome, Edge, Brave, Opera, Vivaldi or Firefox window over Kessel's
  tab strip and its tabs move into Kessel.
- **Workspaces**: separate sets of tabs. The ones you're not in sleep.
- **Accounts**: be signed in as different people at once, like Firefox
  containers but in one window. Each account has its own cookies and
  storage.
- Private windows (Ctrl+Shift+N) with their own in-memory profile.

### Make it yours
- **11 interface styles**: Liquid Glass, Hyper Clean, Futuristic, Robust,
  Vintage, Gamer, Fluent, Soft, Terminal, Aqua and Brutal. Each has about
  150 options (colours, shapes, fonts, spacing, glass, motion), and you
  can save your own presets.
- Wallpapers behind the toolbar and the new-tab page, including your own
  picture. The glass's text adjusts to how light or dark the wallpaper is.
- Chrome themes from the Web Store recolour whichever style you use.
- Custom keyboard shortcuts, UI scaling, interface sounds, and mouse
  gestures.

### A smart address bar
- Suggestions from your history, bookmarks and open tabs, with inline
  completion.
- Instant answers: a calculator, unit and currency conversion, and word
  definitions.
- Commands: type an action like "clear history" or "private window". The
  command palette (F2) and command chains run several commands under one
  shortcut.
- Several search engines with keywords (`yt cats`, `wiki glass`), your own
  engines, and search suggestions you can turn off.
- Share any page as a QR code, a plain link, or Markdown.

### Shields: ads, trackers and fingerprinting
- Brave's own filter engine (`adblock-rust`) with EasyList, EasyPrivacy,
  uBlock Origin's filters and Peter Lowe's list, plus optional
  cookie-notice, annoyance and regional lists.
- Blocking happens in the network layer, for every request a page makes. Element hiding
  removes what's left.
- uBlock Origin's scriptlets, which is what removes YouTube's in-video ads.
- HTTPS by default, with a fallback to http. Tracking parameters are
  stripped from links, and AMP pages open at their real address.
- Fingerprinting protection: per-site noise on canvas, audio and WebGL
  readouts, the screen size and the timezone.
- A Shields button in the address bar with a live count, and on/off for
  each site.

### Privacy
- A cookie viewer and editor, plus per-site cookie rules: allow, keep until
  Kessel closes, or block.
- Third-party cookies are blocked, while partitioned cookies still work
  (total cookie protection).
- Clear data when Kessel closes, or forget a site as soon as its last tab
  closes.
- Global Privacy Control, Do Not Track, and referrer and user-agent
  controls.

### Security
- **Safe browsing that never phones home.** Kessel checks sites against
  the URLhaus malware, phishing and uBlock "badware" lists on your PC, and
  shows a warning page for dangerous sites.
- HTTPS-only mode, a "Not secure" chip on http sites, and Windows' own
  certificate viewer.
- A prompt before risky downloads, and Kessel's own permission prompt for
  the camera, location, notifications and multiple downloads, remembered
  per site.

### Passwords
- An encrypted vault (AES-256-GCM, keyed with Argon2id) behind a master
  password, with optional two-factor unlock (TOTP). It locks itself when
  idle.
- Autofill that Rust decides from the page's real address, so a
  look-alike site can't ask for another site's password.
- A password generator, notes, search, and import from other browsers or
  a CSV file.

### Bookmarks, history and downloads
- **Bookmarks:** folders inside folders, a bookmark manager (Ctrl+Shift+O)
  with search by words or `#tag`, notes, drag to move, sorting, and cards
  with page previews.
- **The star** opens a popup to file a bookmark in a folder and add tags
  and a note.
- **Tidying up:** duplicate detection, a check for links that no longer
  work, and a backup once a day. Bookmarks import from and export to the
  HTML format every browser uses.
- **History:** kept in a database, and browsable by day or by site, with a
  list of the searches you made on Google, YouTube, Wikipedia and more.
- **Downloads:** a manager with pause, resume, retry, search and sorting,
  plus per-site download permissions.

### The side panel
- An icon rail like Opera GX's, with a panel that pushes the page aside
  instead of covering it.
- Bookmarks, a reading list, notes, history, a search of everything,
  workspaces and extensions.
- An **AI assistant** panel: ChatGPT, Claude, Gemini, Copilot, Perplexity,
  Le Chat or your own. Right-click selected text to ask about it.
- Pin any site to the rail and it opens in the panel. This works well for
  messaging apps.

### Reading and page tools
- Reader view, highlights, an RSS/Atom feed reader, find in page, and the
  built-in PDF viewer.
- Screenshots of the visible area, the whole page or a dragged area, with
  an editor.
- Per-site tools:
  - **boosts** (your own CSS for a site);
  - **page filters** (dark, grayscale, sepia, contrast);
  - an **element zapper**;
  - auto-reload.
- Link previews in a floating window, link hints to open links from the
  keyboard, and break mode, which pauses every page and all sound at once.
- An offer of the Wayback Machine's copy when a page is gone. Tabs you
  haven't looked at in days can close by themselves if you turn that on.

### Extensions and developer tools
- Install extensions from the Chrome Web Store (Manifest V3). You decide
  which sites each one can access.
- The full Chromium DevTools (F12).

### Moving in
- Import from Opera GX, Opera, Brave and Chrome, including each Chrome
  profile separately. Bookmarks, Speed Dial / New Tab shortcuts, cookies
  (so you stay signed in) and passwords come across.
- Bookmark HTML files and password CSV files from any browser also import.

### Kessel for phones
The Android app, in [`kessel-mobile/`](kessel-mobile/), has the same
address bar, Shields, private tabs, bookmarks and history, laid out for
one hand. It comes with every release. Its [README](kessel-mobile/README.md)
explains how to install it and what stays on the desktop.

## What Kessel leaves out
- **Sync.** It would need an online account and a server, and Kessel has
  neither by design. Moving your data happens through import and export
  instead.
- **Its own copy of Chromium.** Web compatibility, media codecs, PDF and
  DevTools come from WebView2, which Windows keeps up to date.

## License

Copyright (C) 2026 the Kessel contributors

This program is free software: you can redistribute it and/or modify it
under the terms of the GNU General Public License as published by the Free
Software Foundation, version 3.

This program is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
FITNESS FOR A PARTICULAR PURPOSE. See the [GNU General Public License](LICENSE)
for more details.

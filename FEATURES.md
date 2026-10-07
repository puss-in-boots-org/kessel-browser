# Kessel feature checklist

Every keyboard shortcut and every item of the "Complete Modern Browser Feature
List", with what Kessel does about it. Section 43 is [Kessel for phones](kessel-mobile/README.md),
the Android app; everything else is the desktop browser. Work happens on the `feature-list`
branch, one small commit per feature or group of features.

## Status legend

| Mark | Meaning |
|---|---|
| ✅ | Built on this branch and tested |
| 🟢 | Already in Kessel before this branch (checked) |
| 🌐 | Provided by the engine (WebView2 / Chromium) itself; verified it works in Kessel |
| 🧪 | Built and unit-tested; waiting for its first run on the real thing (Windows for the desktop, an Android phone for [Kessel for phones](kessel-mobile/README.md)) |
| 🟡 | Partly done -- see the note |
| ⏳ | Not done yet |
| ⏭️ | Skipped -- see the note for why (needs a server, mobile only, not possible in WebView2...) |

## Resuming the work

- Branch: `feature-list` (based on `dev-script-folder`).
- Build (Visual Studio 2022 C++ tools + Windows SDK 10.0.19041, found automatically):
  `scripts\cargo-msvc.cmd build --features tauri/custom-protocol --target-dir target\e2e`
- End-to-end tests: `node tauri-browser/tests/e2e/run.mjs [name filter]` -- starts that
  build with a throw-away profile (your real history/settings are never touched) and
  drives it through the Chrome DevTools Protocol. The front end is compiled into the
  build, so rebuild after changing anything in `src/`.
- Unit tests: `scripts\cargo-msvc.cmd test --target-dir target\e2e` (Rust) and
  `node --test "tauri-browser/tests/unit/*.test.mjs"` (JavaScript).
- Pick the first ⏳ row below, build it, test it, mark it, commit.
- Mark rows with `node scripts/mark-feature.mjs <row> <status> [note]` (e.g.
  `node scripts/mark-feature.mjs 20.03 done`): it also refreshes the Progress
  table below. Once a 🧪 row's end-to-end test has passed on Windows, mark it ✅.

<!-- progress:start -- written by scripts/mark-feature.mjs; don't edit by hand -->
## Progress

**86% overall** -- 714 done (✅ 🟢 🌐), 68 built and waiting for their first run on Windows or a phone (🧪), 45 partly done (🟡), 107 to do (⏳), 111 skipped (⏭️), of 1045.

| Section | Done | 🧪 | 🟡 | ⏳ | ⏭️ | Progress |
|---|---:|---:|---:|---:|---:|---|
| [Keyboard shortcuts (the requested table)](#keyboard-shortcuts-the-requested-table) | 52 |  |  |  |  | `██████████` 100% |
| [1. Core browsing -- navigation](#1-core-browsing----navigation) | 22 |  |  |  |  | `██████████` 100% |
| [2. Tabs](#2-tabs) | 46 |  |  |  | 1 | `██████████` 100% |
| [3. Windows](#3-windows) | 8 | 2 | 3 | 2 |  | `████████░░` 77% |
| [4. Bookmarks](#4-bookmarks) | 18 |  |  |  | 1 | `██████████` 100% |
| [5. History](#5-history) | 15 |  |  |  | 1 | `██████████` 100% |
| [6. Downloads](#6-downloads) | 18 | 2 | 1 | 1 |  | `█████████░` 93% |
| [7. Passwords & identity](#7-passwords--identity) | 24 |  | 1 | 10 | 2 | `███████░░░` 70% |
| [8. Profiles](#8-profiles) | 16 |  |  |  |  | `██████████` 100% |
| [9. Sync](#9-sync) |  |  |  |  | 18 | `██████████` 100% |
| [10. Privacy](#10-privacy) | 38 |  |  |  | 1 | `██████████` 100% |
| [11. Security](#11-security) | 24 |  |  |  |  | `██████████` 100% |
| [12. DNS & networking](#12-dns--networking) | 12 | 2 | 1 | 8 |  | `██████░░░░` 63% |
| [13. Website permissions](#13-website-permissions) | 9 | 3 | 1 |  | 7 | `██████████` 96% |
| [14. Site-specific settings](#14-site-specific-settings) | 15 | 1 |  |  | 6 | `██████████` 100% |
| [15. Extensions / add-ons](#15-extensions--add-ons) | 9 |  | 7 |  | 1 | `████████░░` 78% |
| [16. Built-in content blocking](#16-built-in-content-blocking) | 15 |  | 1 |  |  | `██████████` 97% |
| [17. Reading & research](#17-reading--research) | 15 | 4 | 1 | 2 |  | `█████████░` 89% |
| [18. Translation](#18-translation) | 7 |  | 1 | 2 |  | `████████░░` 75% |
| [19. PDF](#19-pdf) | 11 |  |  | 7 |  | `██████░░░░` 61% |
| [20. Media](#20-media) | 7 | 12 | 1 |  |  | `██████████` 98% |
| [21. Picture-in-picture](#21-picture-in-picture) |  | 6 |  | 1 | 1 | `█████████░` 86% |
| [22. Accessibility](#22-accessibility) | 14 | 2 |  |  |  | `██████████` 100% |
| [23. Appearance](#23-appearance) | 14 |  |  | 2 |  | `█████████░` 88% |
| [24. Search engines](#24-search-engines) | 8 |  |  | 1 |  | `█████████░` 89% |
| [25. Startup behavior](#25-startup-behavior) | 8 |  | 1 |  |  | `█████████░` 94% |
| [26. Session management](#26-session-management) | 9 |  | 1 |  | 1 | `██████████` 95% |
| [27. Browser workspaces](#27-browser-workspaces) | 5 |  | 1 |  | 1 | `█████████░` 92% |
| [28. Sidebar](#28-sidebar) | 11 |  |  |  |  | `██████████` 100% |
| [29. Developer tools](#29-developer-tools) | 11 |  |  |  |  | `██████████` 100% |
| [30. Web platform support](#30-web-platform-support) | 5 |  | 1 |  |  | `█████████░` 92% |
| [31. Progressive Web Apps](#31-progressive-web-apps) | 2 |  |  | 12 | 1 | `█░░░░░░░░░` 14% |
| [32. Notifications](#32-notifications) | 2 | 1 |  | 6 | 1 | `███░░░░░░░` 33% |
| [33. Clipboard](#33-clipboard) | 6 | 1 |  |  |  | `██████████` 100% |
| [34. File system](#34-file-system) | 9 |  |  | 1 |  | `█████████░` 90% |
| [35. Hardware acceleration](#35-hardware-acceleration) | 2 | 6 | 1 |  |  | `█████████░` 94% |
| [36. Performance](#36-performance) | 14 |  |  | 3 |  | `████████░░` 82% |
| [37. Cache](#37-cache) | 9 |  | 1 |  |  | `██████████` 95% |
| [38. Developer / experimental controls](#38-developer--experimental-controls) | 4 | 4 | 1 | 4 |  | `███████░░░` 65% |
| [39. Browser information & diagnostics](#39-browser-information--diagnostics) | 15 | 1 |  |  |  | `██████████` 100% |
| [40. Built-in task management](#40-built-in-task-management) | 7 | 2 |  |  |  | `██████████` 100% |
| [41. Screenshots & capture](#41-screenshots--capture) | 3 | 2 |  | 6 |  | `█████░░░░░` 45% |
| [42. Sharing](#42-sharing) | 2 | 2 |  | 2 | 3 | `███████░░░` 67% |
| [43. Mobile-specific features](#43-mobile-specific-features) |  | 6 | 1 | 6 | 2 | `█████░░░░░` 50% |
| [44. Desktop-specific features](#44-desktop-specific-features) | 11 |  | 1 | 1 |  | `█████████░` 88% |
| [45. Keyboard shortcuts](#45-keyboard-shortcuts) | 27 | 1 |  |  |  | `██████████` 100% |
| [46. Mouse / trackpad](#46-mouse--trackpad) | 8 |  |  | 4 |  | `███████░░░` 67% |
| [47. Context menus](#47-context-menus) | 10 |  |  |  |  | `██████████` 100% |
| [48. AI features](#48-ai-features) | 2 |  | 2 |  | 16 | `████████░░` 75% |
| [49. Shopping](#49-shopping) |  |  |  | 1 | 9 | `░░░░░░░░░░` 0% |
| [50. Media & entertainment extras](#50-media--entertainment-extras) | 4 | 1 |  | 3 | 3 | `██████░░░░` 63% |
| [51. Privacy-focused advanced features](#51-privacy-focused-advanced-features) | 6 |  |  | 5 | 3 | `█████░░░░░` 55% |
| [52. Import / export](#52-import--export) | 15 |  | 2 |  |  | `█████████░` 94% |
| [53. Updates](#53-updates) | 1 |  |  |  | 8 | `██████████` 100% |
| [54. Crash handling](#54-crash-handling) | 9 |  |  |  |  | `██████████` 100% |
| [55. Browser settings](#55-browser-settings) | 5 |  | 6 | 2 | 1 | `██████░░░░` 62% |
| [56. Account system](#56-account-system) | 1 |  |  | 1 | 12 | `█████░░░░░` 50% |
| [57. Browser lock](#57-browser-lock) | 7 | 3 |  |  |  | `██████████` 100% |
| [58. Search / history intelligence](#58-search--history-intelligence) | 9 |  |  | 4 |  | `███████░░░` 69% |
| [59. Offline functionality](#59-offline-functionality) | 8 |  | 1 | 1 |  | `█████████░` 85% |
| [60. Web standards compatibility](#60-web-standards-compatibility) | 8 |  | 3 |  | 1 | `█████████░` 86% |
| [61. Developer-facing browser architecture](#61-developer-facing-browser-architecture) | 14 |  | 1 |  | 2 | `██████████` 97% |
| [62. "Crazy advanced" features](#62-crazy-advanced-features) | 14 | 1 | 2 | 7 | 8 | `███████░░░` 67% |
| [63. Researched additions (2026)](#63-researched-additions-2026) | 14 | 3 | 1 | 2 |  | `█████████░` 88% |

Progress counts done and 🧪 rows, half of each 🟡 row, and leaves ⏭️ rows out.
<!-- progress:end -->

## Keyboard shortcuts (the requested table)

| Shortcut | Action | Status | Notes |
|---|---|---|---|
| F5 | Refresh | ✅ | Reloads (also Ctrl+R); a web app that uses F5 itself keeps it, like in Chrome |
| Ctrl + F5 | Refresh and bypass the cache for the current page | ✅ | Also Shift+F5 and Ctrl+Shift+R: fetches the page and everything on it fresh (no-cache) |
| Alt + Left Arrow | Back | ✅ | Also the mouse's back button and the keyboard's Back key |
| Alt + Right Arrow | Forward | ✅ | Also the mouse's forward button and the keyboard's Forward key |
| Alt + Home | Go to the home page | ✅ | Opens your home page (Settings -> Search & Startup) |
| Escape | Stop loading | ✅ | Stops a page that is loading; otherwise Escape stays the page's (closing its dialogs) |
| F6 / Alt + D / Ctrl + L | Select the address bar | ✅ | Selects the whole address |
| F11 | Full screen on/off | ✅ | Hides the toolbar too; F11 again (or a video leaving full screen) brings it back |
| Home | Scroll to top of page | 🌐 | Tested with real key presses |
| End | Scroll to bottom of page | 🌐 | Tested with real key presses |
| Spacebar | Scroll down | 🌐 | Tested with real key presses |
| Shift + Spacebar | Scroll up | 🌐 | Tested with real key presses |
| Page Down / Page Up | Scroll down / up | 🌐 | Tested with real key presses |
| Ctrl + C | Copy selected text | 🌐 | Tested with real key presses |
| Ctrl + X | Cut selected text | 🌐 | Tested with real key presses |
| Ctrl + V | Paste | 🌐 | Tested with real key presses |
| Ctrl + D | Bookmark current page | ✅ | Bookmarks the page; Ctrl+Shift+D bookmarks every tab |
| F1 | Help page | ✅ | kessel://help: every shortcut (yours included), mouse, address bar, privacy, troubleshooting, versions |
| F3 | Find in page / find next | ✅ | The engine's own find bar (match count, highlight); starts a search if none is open |
| Shift + F3 | Find previous | ✅ | |
| Ctrl + F | Find in page | ✅ | Starts with the selected text, like Chrome |
| Ctrl + G | Find next | ✅ | |
| Ctrl + Shift + G | Find previous | ✅ | |
| Ctrl + H | Browsing history | ✅ | New History page (kessel://history): search, by day, by site, your searches, recently closed; delete pages, sites, days |
| Ctrl + J | Downloads | ✅ | Downloads page |
| Ctrl + O | Open a local file | ✅ | Windows' Open dialog; the file opens in a new tab |
| Ctrl + S | Save the current page | ✅ | The engine's Save As: complete page, HTML only, or a single file |
| Ctrl + P | Print | ✅ | The engine's print preview (printers, PDF, layout) |
| Ctrl + E / Ctrl + K | Select the search box | ✅ | Starts a search: '?' in the address bar searches even for what looks like an address |
| Ctrl + Shift + Del | Clear browsing data | ✅ | Clear browsing data: time range; history, downloads, cookies and site data, cache, autofill, site settings; other accounts too if you want |
| Alt + Enter (address bar) | Open in a new tab | ✅ | Opens it in a new tab; Shift+Enter in a new window |
| Ctrl + Enter (address bar) | Open the term as a website (www. + .com) | ✅ | kessel -> www.kessel.com |
| F12 | Developer tools | ✅ | Also Ctrl+Shift+I / J / C |
| Ctrl + U | View source | ✅ | Opens the page's source in a new tab |
| Alt + F | Open the browser menu | ✅ | The Kessel menu (also Alt+E, F10 and the menu button) |
| Ctrl + N | New window | ✅ | Ctrl+Shift+N: a private window |
| Ctrl + Tab | Next tab | ✅ | Also Ctrl+PageDown |
| Ctrl + Shift + Tab | Previous tab | ✅ | Also Ctrl+PageUp |
| Ctrl + F4 | Close the current tab | ✅ | Also Ctrl+W |
| Ctrl + T | New tab | ✅ | |
| Ctrl + Shift + T | Reopen the last closed tab | ✅ | Reopens a whole window, if a window closed last |
| Alt + F4 | Close the window | ✅ | Closes the window like its X button (also Ctrl+Shift+W) |
| Ctrl + 1 ... 8 | Go to tab 1-8 | ✅ | |
| Ctrl + 9 | Go to the last tab | ✅ | |
| Ctrl + Mouse wheel | Zoom in / out | ✅ | Zoom belongs to the site and is remembered; also Ctrl +/-; the address bar shows it |
| Ctrl + 0 | Reset zoom to 100% | ✅ | Back to your default zoom (Settings -> Appearance) |
| Middle click | Close a tab / open a link in a new tab / autoscroll | ✅ | Closes a tab; opens a link behind the current tab (Settings -> Keyboard & Mouse); autoscroll on the page |
| Ctrl + Left click | Open link in a new tab | ✅ | In front or behind: Settings -> Keyboard & Mouse |
| Shift + Left click | Open link in a new window | ✅ | |
| Ctrl + Shift + Left click | Open link in a new background tab | ✅ | |
| Ctrl + Z | Undo | 🌐 | Tested with real key presses |
| Ctrl + Y | Redo | 🌐 | Tested with real key presses |

## Feature list

### 1. Core browsing -- navigation

| # | Feature | Status | Notes |
|---|---|---|---|
| 1.01 | Address bar / omnibox | ✅ | Suggestions as you type (history, bookmarks, open tabs, your search engine), in-place completion, answers and commands; Up/Down, Enter, Alt/Shift+Enter, Tab, Shift+Delete |
| 1.02 | Back | ✅ | Button, Alt+Left, mouse back button |
| 1.03 | Forward | ✅ | Button, Alt+Right, mouse forward button |
| 1.04 | Reload | ✅ | Button, F5, Ctrl+R |
| 1.05 | Hard reload | ✅ | Ctrl+F5, Shift+F5, Ctrl+Shift+R |
| 1.06 | Stop loading | ✅ | Escape, or the reload button, which turns into a stop button while loading |
| 1.07 | Home button | ✅ | Next to reload (Settings -> Appearance can hide it); Alt+Home; stays in the same tab |
| 1.08 | Home page | 🟢 | Settings -> Search & Startup |
| 1.09 | New tab page | 🟢 | |
| 1.10 | Search from address bar | 🟢 | |
| 1.11 | URL suggestions | ✅ | Your history (often and lately visited first), bookmarks and open tabs; "yout" completes to youtube.com in place |
| 1.12 | Search suggestions | ✅ | From your search engine as you type (Google, Bing, DuckDuckGo, Brave, Ecosia, Startpage); off in private windows; Settings -> Search |
| 1.13 | Command suggestions | ✅ | Kessel's commands by name or another word for them ("clear cache", "incognito"...), with their shortcut |
| 1.14 | Calculator | ✅ | + - * / ^ % ! mod, sqrt, sin, log..., "15% of 80", "80 + 15%"; Enter copies the result |
| 1.15 | Unit conversion | ✅ | Length, mass, volume, area, speed, time, data, energy, pressure, temperature ("10 km to miles") |
| 1.16 | Currency conversion | ✅ | "100 usd to huf": the European Central Bank's daily rates (~30 currencies); last rates kept for offline |
| 1.17 | Definitions | ✅ | "define serendipity", "ephemeral meaning": from Wiktionary |
| 1.18 | Quick answers | ✅ | The time anywhere ("time in tokyo"), the date, coin, dice ("roll 2d6"), random numbers, UUID, strong password, colours (#hex / rgb), number bases |
| 1.19 | QR-code generation | ✅ | Share button -> the page's QR code |
| 1.20 | Share page | ✅ | Share button -> Share... opens Windows' Share window; also the menu |
| 1.21 | Copy page link | ✅ | Share button -> Copy link (also as a Markdown link); the menu; a command you can give a shortcut |
| 1.22 | Copy link as QR code | ✅ | Share button -> Copy QR code (an image) |

### 2. Tabs

| # | Feature | Status | Notes |
|---|---|---|---|
| 2.01 | New tab | 🟢 | |
| 2.02 | Close tab | 🟢 | |
| 2.03 | Duplicate tab | 🟢 | Tab right-click menu |
| 2.04 | Reopen closed tab | 🟢 | |
| 2.05 | Pin tab | ✅ | Tab menu or a shortcut you give it: icon only, in front, no close button; comes back pinned after a restart |
| 2.06 | Mute tab | ✅ | Ctrl+M, the tab menu, or a click on the tab's speaker |
| 2.07 | Unmute tab | ✅ | Ctrl+M again, the tab menu, or the speaker; a sleeping muted tab wakes up muted |
| 2.08 | Drag tabs to reorder | 🟢 | |
| 2.09 | Drag tab into another window | ✅ | Drop a tab on another window's tab strip: the page moves along, no reload |
| 2.10 | Drag tab out into a new window | ✅ | Drop a tab outside the strip: it moves into a new window where you let go (Pop out is in the tab menu) |
| 2.11 | Move tab to another window | ✅ | Tab right-click: Move to new window / Move to window with ... |
| 2.12 | Reload tab | ✅ | Tab menu -> Reload |
| 2.13 | Reload multiple tabs | ✅ | Ctrl/Shift+click several tabs, then Reload N tabs; every tab action works on picked tabs |
| 2.14 | Close other tabs | ✅ | Tab menu or a shortcut; pinned tabs stay |
| 2.15 | Close tabs to the left | ✅ | Tab menu, or a shortcut you give it |
| 2.16 | Close tabs to the right | ✅ | Tab menu, or a shortcut you give it |
| 2.17 | Close tabs except pinned tabs | ✅ | Tab menu -> Close all but pinned tabs |
| 2.18 | Bookmark all tabs | ✅ | Ctrl+Shift+D, and the menu |
| 2.19 | Tab groups | ✅ | Your own groups (right-click a tab), besides each account's tabs |
| 2.20 | Named tab groups | ✅ | Typed right in the strip when you make one; double-click the name to rename |
| 2.21 | Colored tab groups | ✅ | Nine colours, from the group's right-click menu; a line in its colour under its tabs |
| 2.22 | Collapsed tab groups | ✅ | Click a group's name to fold it (Ctrl+Tab skips it); folding the group you're in moves you out |
| 2.23 | Persistent tab groups | ✅ | Kept with the session, with each window, and when tabs move to another window |
| 2.24 | Automatic tab grouping | ✅ | Group tabs by site (tab menu, address bar), or automatically for new tabs (Settings -> Tabs) |
| 2.25 | Tab group saving | ✅ | Save group: a chip on the bookmarks bar reopens it; the saved copy follows changes to the group |
| 2.26 | Tab group synchronization | ⏭️ | Needs an account and sync server Kessel doesn't have; saved groups stay in step across this PC's windows |
| 2.27 | Tab search | ✅ | Ctrl+Shift+A or the arrow beside the tabs: every tab of every window, sleeping and recently closed ones, with memory use and a preview |
| 2.28 | Recently closed tabs | ✅ | Ctrl+Shift+T; History -> Recently closed; Settings -> History |
| 2.29 | Recently closed windows | ✅ | Ctrl+Shift+T when a window closed last; History -> Recently closed; the menu's Reopen closed window |
| 2.30 | Vertical tabs | ✅ | Settings -> Tabs -> Side: a resizable column, collapsible to icons |
| 2.31 | Horizontal tabs | ✅ | Along the top (the default) |
| 2.32 | Scrollable tab bar | ✅ | Mouse wheel and arrows at its ends; the tab you're on stays in view |
| 2.33 | Tab overflow management | ✅ | Tabs shrink toward their icons, or keep titles and scroll (Settings -> Tabs); tab search lists every tab |
| 2.34 | Tab previews | ✅ | Hover cards show a picture of the page |
| 2.35 | Tab thumbnails | ✅ | Taken as you leave a tab; in hover cards and tab search |
| 2.36 | Hover cards | ✅ | Title, site, state, group, memory/CPU and a preview; on or off in Settings -> Tabs |
| 2.37 | Tab audio indicators | ✅ | A speaker on tabs playing sound (crossed out when muted); click to mute or unmute; tabs playing sound never go to sleep |
| 2.38 | Tab notification indicators | ✅ | A dot on a background tab whose page changed its title |
| 2.39 | Sleeping tabs | ✅ | Idle tabs go to sleep (Settings -> Performance); tab menu -> Put to sleep; never tabs playing sound or listed sites |
| 2.40 | Discarded tabs | ✅ | Asleep tabs wake up (reload) when clicked |
| 2.41 | Tab freezing | ✅ | Background tabs are paused after a while (Settings -> Performance): their scripts stop until you return |
| 2.42 | Tab memory usage indicators | ✅ | Memory per tab in hover cards and tab search; an orange ring on tabs using over 1.5 GB |
| 2.43 | Tab CPU usage indicators | ✅ | CPU per tab in hover cards; an orange ring on tabs busy for 10 s |
| 2.44 | Automatic resource throttling | ✅ | Background tabs are hidden from the engine (timers throttled, nothing drawn) and asked to use less memory |
| 2.45 | Tab suspension | ✅ | Paused tabs (scripts stopped) and sleeping tabs (webview closed) |
| 2.46 | Background-tab limits | ✅ | Settings -> Performance: keep at most N tabs awake |
| 2.47 | Tab lifecycle management | ✅ | Shown -> hidden -> paused -> asleep, with never-sleep sites and exemptions for sound |

### 3. Windows

| # | Feature | Status | Notes |
|---|---|---|---|
| 3.01 | Multiple browser windows | ✅ | Any number of windows, each with its own tabs, side panel and popups |
| 3.02 | Private windows | ✅ | InPrivate tabs: no history, session or recently-closed entries; Private badge in the tab bar |
| 3.03 | Incognito windows | ✅ | Same as private windows |
| 3.04 | Separate profile windows | ✅ | Another profile opens in windows of its own, its name on them; account pop-out windows too |
| 3.05 | Always-on-top window mode | 🟡 | Pop-out windows only |
| 3.06 | Picture-in-picture windows | 🧪 | The engine's picture-in-picture window: media controls or Alt+P (20.05) |
| 3.07 | Pop-out video windows | 🧪 | A video pops out into the engine's picture-in-picture window (media controls or Alt+P) |
| 3.08 | Restore previous windows | ✅ | Session restore reopens every window with its own tabs |
| 3.09 | Restore individual windows | ✅ | Reopen closed window, any closed window from History -> Recently closed, or one window of a saved session |
| 3.10 | Window session saving | ✅ | Each window's tabs are saved as they change |
| 3.11 | Window organization | 🟡 | Name windows, move tabs between them, save them as sessions |
| 3.12 | Window naming | ✅ | Command palette -> Name window…: the name shows in its tab bar and is its title on the taskbar; it comes back with the session |
| 3.13 | Split-screen browser windows | ⏳ | |
| 3.14 | Side-by-side page viewing | 🟡 | The side panel shows a second page beside the tab |
| 3.15 | Window-specific tab groups | ⏳ | |

### 4. Bookmarks

| # | Feature | Status | Notes |
|---|---|---|---|
| 4.01 | Bookmark page | 🟢 | |
| 4.02 | Bookmark folders | ✅ | |
| 4.03 | Nested folders | ✅ | |
| 4.04 | Bookmark bar | 🟢 | |
| 4.05 | Bookmark manager | ✅ | kessel://bookmarks (Ctrl+Shift+O) |
| 4.06 | Bookmark search | ✅ | Names, addresses, notes, #tags |
| 4.07 | Bookmark editing | ✅ | |
| 4.08 | Bookmark deletion | 🟢 | |
| 4.09 | Bookmark sorting | ✅ | By name, address or date; drag to reorder |
| 4.10 | Bookmark import | ✅ | Any browser's HTML export; straight from Opera GX, Opera, Brave, Chrome, Edge, Vivaldi and Firefox, folders kept |
| 4.11 | Bookmark export | ✅ | HTML (the format every browser imports) |
| 4.12 | Bookmark synchronization | ⏭️ | Needs an online account or server: left out |
| 4.13 | Bookmark tags | ✅ | |
| 4.14 | Bookmark descriptions | ✅ | |
| 4.15 | Favicons | 🟢 | |
| 4.16 | Bookmark previews | ✅ | A picture of the page when you star it; the manager's cards |
| 4.17 | Bookmark duplicate detection | ✅ | Also the same page at another address (tracking, www., http) |
| 4.18 | Bookmark organization tools | ✅ | Duplicates, links that stopped working, moving and deleting several |
| 4.19 | Bookmark backup | ✅ | One a day, the last two weeks; restore in the manager |

### 5. History

| # | Feature | Status | Notes |
|---|---|---|---|
| 5.01 | Browsing history | ✅ | Now a database (SQLite) instead of the last 500 visits; kept 90 days by default |
| 5.02 | History search | ✅ | Every word must appear in the title or address |
| 5.03 | History by date | ✅ | Grouped by day; Today, Yesterday, last 7 / 30 days, or any single day |
| 5.04 | History by website | ✅ | History -> By site: visits per site; show or delete a whole site |
| 5.05 | History by tab/window | ✅ | Right-click Back or Forward: the tab's own history, nearest first; picking a page goes straight there (tested) |
| 5.06 | Delete individual entries | ✅ | A page's menu, or tick several and Delete |
| 5.07 | Delete time ranges | ✅ | Clear browsing data (last hour ... all time); or a day's pages in History |
| 5.08 | Clear all browsing history | ✅ | Clear browsing data -> All time |
| 5.09 | Recently closed pages | 🟢 | |
| 5.10 | Recently closed tabs | 🟢 | |
| 5.11 | Recently closed windows | ✅ | See 2.29 |
| 5.12 | Search history | ✅ | History -> Searches: what you searched on Google, Bing, DuckDuckGo, YouTube, Wikipedia, Amazon and more |
| 5.13 | Download history | 🟢 | |
| 5.14 | History synchronization | ⏭️ | Needs an online account or server: left out |
| 5.15 | History suggestions | ✅ | In the address bar, as you type |
| 5.16 | Address-bar history integration | ✅ | See 1.11 |

### 6. Downloads

| # | Feature | Status | Notes |
|---|---|---|---|
| 6.01 | Download manager | 🟡 | Basic list |
| 6.02 | Download list | 🟢 | |
| 6.03 | Download progress | ✅ | Downloads list: size so far, of how much, and a progress bar |
| 6.04 | Pause downloads | ✅ | Downloads list -> Pause |
| 6.05 | Resume downloads | ✅ | Downloads list -> Resume (also after a dropped connection, if the site allows) |
| 6.06 | Cancel downloads | ✅ | Downloads list -> Cancel |
| 6.07 | Retry failed downloads | ✅ | Downloads list -> Try again (fetches it anew) |
| 6.08 | Open downloaded file | 🟢 | |
| 6.09 | Show downloaded file in folder | 🧪 | Downloads list -> Show in folder |
| 6.10 | Change download location | ✅ | Settings -> Downloads -> Save downloads to |
| 6.11 | Ask where to save every file | 🧪 | Settings -> Downloads -> Ask where to save each file |
| 6.12 | Automatic downloads | ✅ | Site permissions -> Several downloads at once (ask, allow or block, per site) |
| 6.13 | Multiple simultaneous downloads | 🟢 | |
| 6.14 | Download notifications | 🟢 | Toasts |
| 6.15 | Dangerous-download detection | 🟢 | Risky downloads wait for you to keep or discard them (Settings -> Security) |
| 6.16 | File-type warnings | 🟢 | Programs and scripts (exe, msi, bat, ps1...) from plain http or bad sites are held back |
| 6.17 | Download scanning | ⏳ | |
| 6.18 | Download history | 🟢 | |
| 6.19 | Download sorting | ✅ | Downloads list: newest, oldest, by name or by site |
| 6.20 | Download search | ✅ | Downloads list: search by name or address |
| 6.21 | Automatic download organization | ✅ | Settings -> Downloads: sort downloads into Pictures, Videos, Music, Documents, Archives, Programs folders |
| 6.22 | Per-site download permissions | ✅ | Site permissions -> Several downloads at once, per site |

### 7. Passwords & identity

| # | Feature | Status | Notes |
|---|---|---|---|
| 7.01 | Password manager | 🟢 | Encrypted vault (AES-256-GCM, Argon2id, optional TOTP) |
| 7.02 | Save passwords | ✅ | After you sign in, Kessel offers to save the password (or update the saved one); never in private windows; never-list per site |
| 7.03 | Autofill passwords | ✅ | A chip under the password field on a saved site's sign-in page fills it in on click; Kessel matches the site by the page's real address |
| 7.04 | Generate strong passwords | 🟢 | |
| 7.05 | Password editing | 🟢 | |
| 7.06 | Password deletion | 🟢 | |
| 7.07 | Password search | 🟢 | The Passwords page's search box |
| 7.08 | Password import | 🟢 | Browsers and CSV |
| 7.09 | Password export | ✅ | Passwords -> settings -> Export: a CSV file Chrome, Edge and Firefox import; asks for the master password first |
| 7.10 | Password synchronization | ⏭️ | Needs an online account or server: left out |
| 7.11 | Password security checks | ✅ | Passwords page: weak, reused and (when you ask) breached passwords, each flagged |
| 7.12 | Weak-password detection | ✅ | Common passwords, short ones, one kind of character, repeats and runs like 1234 |
| 7.13 | Reused-password detection | ✅ | Passwords used on more than one site |
| 7.14 | Compromised-password detection | ✅ | Have I Been Pwned range check, only when you ask: just 5 characters of each password's SHA-1 hash leave the computer |
| 7.15 | Password notes | 🟢 | |
| 7.16 | Password organization | ⏳ | |
| 7.17 | Passkeys | ⏳ | |
| 7.18 | Passkey creation | ⏳ | |
| 7.19 | Passkey login | ⏳ | |
| 7.20 | Passkey storage | ⏳ | |
| 7.21 | Passkey synchronization | ⏭️ | Needs an online account or server: left out |
| 7.22 | Hardware-security-key authentication | ⏳ | |
| 7.23 | Biometric authentication | ⏳ | |
| 7.24 | WebAuthn | ⏳ | |
| 7.25 | FIDO2 | ⏳ | |
| 7.26 | Security-key support | ⏳ | |
| 7.27 | Username autofill | ✅ | With the password (7.03) |
| 7.28 | Password autofill | ✅ | See 7.03 |
| 7.29 | Name autofill | ✅ | Settings -> Addresses & cards: a name (whole, first or last) filled in from Kessel's own list under the field -- the page never sees the list |
| 7.30 | Address autofill | ✅ | Street, city, region, postal code and country -- a country list is picked by its name |
| 7.31 | Phone-number autofill | ✅ | Phone numbers, from the same addresses |
| 7.32 | Email autofill | ✅ | Email addresses, from the same addresses |
| 7.33 | Payment autofill | ✅ | Cards filled in from the list under the field, on secure pages: number, name, expiry -- never a security code |
| 7.34 | Credit/debit card storage | ✅ | Kept encrypted for your Windows account (DPAPI); lists show only its last 4 digits |
| 7.35 | Expiration-date autofill | ✅ | MM/YY, MM/YYYY, or a month and a year field (lists too) |
| 7.36 | Form-data autofill | 🟡 | Addresses and cards, offered to save when a form is sent (7.29-7.35); other fields aren't remembered |
| 7.37 | One-click autofill | ✅ | See 7.03 |

### 8. Profiles

| # | Feature | Status | Notes |
|---|---|---|---|
| 8.01 | Multiple browser profiles | ✅ | Profiles (Settings -> Profiles, 8.02), and accounts for separate sign-ins in one window |
| 8.02 | Separate profile history | ✅ | Settings -> Profiles (Ctrl+Shift+M): each profile its own history, bookmarks, passwords, settings, cookies and extensions, in a Kessel of its own; open one or make one there |
| 8.03 | Separate bookmarks | ✅ | See 8.02 |
| 8.04 | Separate passwords | ✅ | See 8.02 |
| 8.05 | Separate extensions | ✅ | See 8.02 |
| 8.06 | Separate cookies | 🟢 | Accounts |
| 8.07 | Separate browsing sessions | 🟢 | Accounts |
| 8.08 | Profile avatars | 🟢 | Accounts |
| 8.09 | Profile names | 🟢 | Accounts |
| 8.10 | Profile colors/themes | ✅ | Each profile has its own look (Settings -> Appearance) and its name on its windows; accounts their colours |
| 8.11 | Profile switching | 🟢 | Accounts |
| 8.12 | Profile startup shortcuts | ✅ | Settings -> Profiles -> Desktop shortcut: opens Kessel straight into that profile |
| 8.13 | Profile-specific settings | ✅ | Each profile keeps its own settings |
| 8.14 | Profile-specific search engines | ✅ | Each profile keeps its own search engines and keywords |
| 8.15 | Profile-specific downloads | ✅ | Each profile keeps its own downloads folder and list |
| 8.16 | Profile isolation | 🟢 | Separate WebView2 data folder per account |

### 9. Sync

| # | Feature | Status | Notes |
|---|---|---|---|
| 9.01 | Bookmark sync | ⏭️ | Needs an online account or server: left out |
| 9.02 | History sync | ⏭️ | Needs an online account or server: left out |
| 9.03 | Password sync | ⏭️ | Needs an online account or server: left out |
| 9.04 | Extension sync | ⏭️ | Needs an online account or server: left out |
| 9.05 | Settings sync | ⏭️ | Needs an online account or server: left out |
| 9.06 | Open-tab sync | ⏭️ | Needs an online account or server: left out |
| 9.07 | Tab-group sync | ⏭️ | Needs an online account or server: left out |
| 9.08 | Autofill sync | ⏭️ | Needs an online account or server: left out |
| 9.09 | Reading-list sync | ⏭️ | Needs an online account or server: left out |
| 9.10 | Theme sync | ⏭️ | Needs an online account or server: left out |
| 9.11 | Browser configuration sync | ⏭️ | Needs an online account or server: left out |
| 9.12 | Cross-platform synchronization | ⏭️ | Needs an online account or server: left out |
| 9.13 | Encrypted synchronization | ⏭️ | Needs an online account or server: left out |
| 9.14 | Selective synchronization | ⏭️ | Needs an online account or server: left out |
| 9.15 | Sync conflict handling | ⏭️ | Needs an online account or server: left out |
| 9.16 | Sync status | ⏭️ | Needs an online account or server: left out |
| 9.17 | Sync device list | ⏭️ | Needs an online account or server: left out |
| 9.18 | Remote device management | ⏭️ | Needs an online account or server: left out |

### 10. Privacy

| # | Feature | Status | Notes |
|---|---|---|---|
| 10.01 | Allow cookies | 🌐 | Sites keep cookies unless you say otherwise (Settings → Cookies & site data) |
| 10.02 | Block cookies | ✅ | Settings → Cookies & site data: sites may keep cookies -- yes / until you close Kessel / no -- and per-site rules. WebView2 has no cookie policy to set, so a sweep over the cookie jar (as pages load, and every minute) deletes a blocked site's cookies, and its pages get no document.cookie (privacy.rs) |
| 10.03 | Block third-party cookies | ✅ | On by default: Chromium's own third-party cookie blocking (engine switch, after a restart); partitioned cookies keep working. A switch in Settings → Cookies & site data |
| 10.04 | Delete cookies | ✅ | One cookie, or a whole site's, in Settings → Cookies & site data (and Clear browsing data) |
| 10.05 | Per-site cookie settings | ✅ | Allow / until Kessel closes / block, per site (covering its subdomains; the most specific rule wins) -- in Settings, or from the address bar's lock (site info) |
| 10.06 | Cookie viewer | ✅ | Settings → Cookies & site data: every cookie by site, with its domain, path, expiry and flags, searchable |
| 10.07 | Cookie editor | ✅ | Add or edit a cookie: name, value, domain, path, expiry, Secure, HttpOnly, SameSite |
| 10.08 | Cookie expiration controls | ✅ | "Keep cookies at most" a day … a year: longer-lived cookies are cut short by the sweep; any cookie's expiry in the editor |
| 10.09 | Session-only cookies | ✅ | "Until you close Kessel" -- for every site, or per site: their cookies become session cookies |
| 10.10 | Cookie isolation | 🟢 | Accounts (each has its own cookie jar); private windows too |
| 10.11 | Partitioned cookies | 🌐 | CHIPS: a Partitioned cookie in another site's frame is kept, for that page only (tested) |
| 10.12 | Tracker blocking | 🟢 | Shields |
| 10.13 | Third-party tracker blocking | 🟢 | Shields |
| 10.14 | Cross-site tracking protection | 🟢 | Shields + WebView2 tracking prevention |
| 10.15 | Social-media tracker blocking | 🟢 | Shields lists |
| 10.16 | Ad tracker blocking | 🟢 | Shields |
| 10.17 | Fingerprinting protection | 🟢 | Shields farbling |
| 10.18 | Cryptomining protection | 🟢 | Shields lists |
| 10.19 | Tracking URL removal | 🟢 | Shields |
| 10.20 | Bounce-tracking protection | ✅ | With Shields: click-tracking redirect pages (google.com/url, l.facebook.com, out.reddit.com, youtube.com/redirect, steamcommunity.com/linkfilter, …) are skipped straight to where they point |
| 10.21 | Storage partitioning | 🌐 | A site's frame inside another site gets storage of its own (tested with localStorage) |
| 10.22 | First-party isolation | 🌐 | Storage partitioning + third-party cookie blocking: each site only sees what it keeps itself |
| 10.23 | Total cookie protection | ✅ | Third-party cookies blocked with partitioned ones allowed: a site's cookies in other sites' pages live in a jar per page site, like Firefox's Total Cookie Protection |
| 10.24 | Private browsing | 🟢 | Private windows (Ctrl+Shift+N): their own in-memory profile, no history, gone when closed |
| 10.25 | Incognito mode | 🟢 | The same private windows |
| 10.26 | Automatic private sessions | ✅ | Settings → Privacy: "Always use private windows" |
| 10.27 | Clear data on exit | ✅ | Settings → Cookies & site data: history, the downloads list, cookies and site data, cached files, autofill, site settings -- cleared when the last window closes or you quit |
| 10.28 | Per-site data deletion | ✅ | "Delete site data" -- cookies, storage, caches and service workers of every address of the site -- in Settings or the lock's popup |
| 10.29 | Global privacy controls | ✅ | Global Privacy Control and Do Not Track switches (Settings → Privacy) |
| 10.30 | Do Not Track | ✅ | Off by default (few sites honour it, and it makes you stand out): the DNT header and navigator.doNotTrack |
| 10.31 | Global Privacy Control | ✅ | On by default: the Sec-GPC header on requests (Shields or not) and navigator.globalPrivacyControl |
| 10.32 | Referrer controls | ✅ | Just the site (default) / nothing to other sites / nothing ever: set as each page's own referrer policy as it starts, and document.referrer. (The engine adds the Referer header after Kessel sees a request, so it can't be taken off there) |
| 10.33 | User-agent privacy controls | ✅ | Kessel (Edge's engine) / Google Chrome / your own, for tabs opened from then on. Client hints (Sec-CH-UA) still name the engine |
| 10.34 | Fingerprint resistance | 🟢 | Shields farbling -- canvas, audio, CPU cores, and now WebGL and screen size |
| 10.35 | Canvas fingerprint protection | 🟢 | |
| 10.36 | WebGL fingerprint protection | ✅ | Farbling: a common graphics card vendor/renderer instead of yours, and faint noise on pixels read back |
| 10.37 | Font fingerprint protection | ⏭️ | Not possible from outside the engine: WebView2 has no say over which fonts pages can use or measure (Brave does it inside Chromium) |
| 10.38 | Screen-size fingerprint protection | ✅ | Farbling: the screen is the size of the window (no monitor size or layout) |
| 10.39 | Timezone fingerprint protection | ✅ | Opt-in (Settings → Privacy): pages run in UTC (the engine's time zone override), and other sites' frames read UTC too |

### 11. Security

| # | Feature | Status | Notes |
|---|---|---|---|
| 11.01 | HTTPS support | 🌐 | |
| 11.02 | HTTPS-only mode | ✅ | Settings → Security: every site is opened as https; one without it gets a warning page first ("continue" lasts until a restart). Addresses on your own network are left alone |
| 11.03 | HTTP warning | ✅ | A red "Not secure" chip in the address bar on http sites; the lock opens the site info (connection, certificate, cookies) |
| 11.04 | TLS | 🌐 | |
| 11.05 | Certificate validation | 🌐 | |
| 11.06 | Certificate warnings | ✅ | A warning page saying what's wrong (expired, another site's, untrusted, revoked), with "go on (unsafe)" -- remembered until a restart |
| 11.07 | Certificate viewer | ✅ | The lock → Certificate: Windows' own certificate dialog, for the certificate the site sends (fetched fresh -- WebView2 doesn't hand out its page's) |
| 11.08 | HSTS | 🌐 | |
| 11.09 | Certificate Transparency | 🌐 | |
| 11.10 | Mixed-content blocking | 🌐 | |
| 11.11 | Safe Browsing | ✅ | On this PC, nothing sent anywhere: the URLhaus malware, phishing and uBlock "badware" lists, refreshed twice a day, checked whether Shields is up or down. Opt-in: Microsoft Defender SmartScreen (sends addresses to Microsoft; after a restart) |
| 11.12 | Phishing protection | ✅ | Phishing URL Blocklist → a "Deceptive site ahead" warning page |
| 11.13 | Malware protection | ✅ | URLhaus (malware sites and files) → a warning page; downloads of listed files wait for you |
| 11.14 | Dangerous-download protection | ✅ | A download from the malware lists, or a program over plain http, waits until you keep or discard it (and SmartScreen's checks, if on) |
| 11.15 | Deceptive-site warnings | ✅ | Warning pages for deceptive, malware and badware sites (and pages Shields blocks outright), with a way on for the session |
| 11.16 | Malicious-extension protection | ✅ | Update checks read the store's verdict: an extension the Chrome Web Store took down as malware is turned off and marked, like Chrome does; one no longer in its store is marked |
| 11.17 | Permission warnings | 🟢 | Extensions list what they may do before you add them, and an update asking for more waits for you; sites' permission prompts are the engine's |
| 11.18 | Sandboxing | 🌐 | |
| 11.19 | Site isolation | 🌐 | |
| 11.20 | Process isolation | 🌐 | |
| 11.21 | Origin isolation | 🌐 | |
| 11.22 | Cross-origin restrictions | 🌐 | |
| 11.23 | Content Security Policy support | 🌐 | |
| 11.24 | Secure-context enforcement | 🌐 | |

### 12. DNS & networking

| # | Feature | Status | Notes |
|---|---|---|---|
| 12.01 | DNS resolution | 🌐 | |
| 12.02 | DNS-over-HTTPS | ⏳ | |
| 12.03 | DNS-over-TLS | ⏳ | |
| 12.04 | Custom DNS | ⏳ | |
| 12.05 | Encrypted DNS | ⏳ | |
| 12.06 | DNS cache | 🌐 | |
| 12.07 | DNS cache clearing | ⏳ | |
| 12.08 | HTTP/1.1 | 🌐 | |
| 12.09 | HTTP/2 | 🌐 | |
| 12.10 | HTTP/3 | 🌐 | |
| 12.11 | QUIC | 🌐 | |
| 12.12 | IPv4 | 🌐 | |
| 12.13 | IPv6 | 🌐 | |
| 12.14 | Proxy support | ✅ | Settings -> Network: no proxy, Windows' setting, a server of your own, or a PAC script (after a restart) |
| 12.15 | SOCKS proxy | 🧪 | socks5://host:port in Settings -> Network |
| 12.16 | HTTP proxy | ✅ | host:port in Settings -> Network, with addresses that skip it |
| 12.17 | PAC files | 🧪 | Settings -> Network -> A setup script (PAC) |
| 12.18 | System proxy | 🌐 | |
| 12.19 | Per-profile proxy | ⏳ | |
| 12.20 | Per-site proxy | ⏳ | |
| 12.21 | Connection diagnostics | 🟡 | kessel://diagnostics -> Network: online, the engine's speed estimate, the proxy |
| 12.22 | Network error reporting | ⏳ | |
| 12.23 | Offline detection | 🌐 | navigator.onLine and the engine's offline page; kessel://diagnostics shows it |

### 13. Website permissions

| # | Feature | Status | Notes |
|---|---|---|---|
| 13.01 | Camera permission | ✅ | Settings -> Site permissions: Kessel's own prompt, answers kept per site |
| 13.02 | Microphone permission | ✅ | Settings -> Site permissions: Kessel's own prompt, answers kept per site |
| 13.03 | Location permission | ✅ | Settings -> Site permissions |
| 13.04 | Notifications permission | ✅ | Settings -> Site permissions |
| 13.05 | Clipboard permission | 🧪 | Settings -> Site permissions |
| 13.06 | Fullscreen permission | ✅ | Site settings (the lock, or Settings -> Site permissions): full screen allowed or blocked per site |
| 13.07 | Motion sensor permission | 🧪 | Settings -> Site permissions (allowed unless you change it) |
| 13.08 | Bluetooth permission | ⏭️ | WebView2 gives apps no device picker: a site's Bluetooth request can't complete |
| 13.09 | USB permission | ⏭️ | WebView2 gives apps no device picker: a site's USB request waits forever |
| 13.10 | Serial-device permission | ⏭️ | WebView2 gives apps no device picker: a site's serial-port request waits forever |
| 13.11 | HID-device permission | ⏭️ | WebView2 gives apps no device picker: a site's HID request waits forever |
| 13.12 | MIDI permission | ✅ | Settings -> Site permissions: Kessel's own prompt |
| 13.13 | Payment permission | ⏭️ | The Payment Request API isn't in WebView2 |
| 13.14 | Autoplay permission | ✅ | Site permissions -> Playing sound on its own: Block stops a site's sound starting before you've done anything there; otherwise the engine's usual rule |
| 13.15 | Pop-up permission | ✅ | Site settings -> Pop-ups: blocked ones show a chip in the address bar (open it, or allow the site); allowed sites' open as tabs |
| 13.16 | Downloads permission | ✅ | Settings -> Site permissions -> Several downloads at once |
| 13.17 | Background activity permission | 🟡 | Settings -> Performance: sites that never sleep keep running in the background; the rest are paused and put to sleep |
| 13.18 | VR/AR permission | ⏭️ | WebXR reports no headset in WebView2 |
| 13.19 | Local-network permission | ⏭️ | WebView2 offers apps no local-network prompt |
| 13.20 | File-system permission | 🧪 | Settings -> Site permissions -> Editing files on your computer |

### 14. Site-specific settings

| # | Feature | Status | Notes |
|---|---|---|---|
| 14.01 | JavaScript | ✅ | Site settings: JavaScript on or off per site (from the next load) |
| 14.02 | Cookies | 🟢 | Settings -> Cookies & site data: allow, block or clear on exit, per site |
| 14.03 | Pop-ups | ✅ | See 13.15 |
| 14.04 | Redirects | ✅ | Site settings: a page sending you to another site on its own (no click) is stopped, with a chip to go anyway |
| 14.05 | Camera | ✅ | Settings -> Site permissions, per site |
| 14.06 | Microphone | ✅ | Settings -> Site permissions, per site |
| 14.07 | Location | ✅ | Settings -> Site permissions, per site |
| 14.08 | Notifications | ✅ | Settings -> Site permissions, per site |
| 14.09 | Clipboard | 🧪 | Settings -> Site permissions, per site |
| 14.10 | Downloads | ✅ | Settings -> Site permissions, per site |
| 14.11 | Autoplay | ✅ | See 13.14 |
| 14.12 | MIDI | ✅ | Settings -> Site permissions, per site |
| 14.13 | Bluetooth | ⏭️ | See 13.08 |
| 14.14 | USB | ⏭️ | See 13.09 |
| 14.15 | Serial | ⏭️ | See 13.10 |
| 14.16 | HID | ⏭️ | See 13.11 |
| 14.17 | VR | ⏭️ | See 13.18 |
| 14.18 | Fullscreen | ✅ | Site settings: full screen allowed or blocked per site |
| 14.19 | Images | ✅ | Site settings: no images for a site |
| 14.20 | Sound | ✅ | Site settings: sound off mutes the site's tabs (and they unmute when they leave it) |
| 14.21 | Background sync | ⏭️ | The engine's own: WebView2 gives apps no per-site control |
| 14.22 | Third-party content | ✅ | Site settings: nothing from other sites (scripts, frames, images) on a site |

### 15. Extensions / add-ons

| # | Feature | Status | Notes |
|---|---|---|---|
| 15.01 | Extension marketplace | ✅ | Chrome Web Store and Edge Add-ons: on an extension's page, "Add to Kessel" in the address bar; Settings -> Extensions links both stores |
| 15.02 | Install extensions | ✅ | From a store (its .crx, over HTTPS; keeps its store id), from a .crx/.zip file, or unpacked from a folder. Run by WebView2 itself; Manifest V2 ones are refused (the engine no longer runs them) |
| 15.03 | Uninstall extensions | ✅ | Settings -> Extensions -> Remove: its data goes with it |
| 15.04 | Enable/disable extensions | ✅ | Settings -> Extensions, the side panel's Extensions page; takes effect at once, data kept |
| 15.05 | Extension permissions | ✅ | What it may do, in words, before it's added and in Settings -> Extensions -> Details |
| 15.06 | Per-site extension permissions | 🟡 | Every site / only sites you list / only when you open it: its scripts for pages obey at once (a guard in front of each); what it may fetch from sites follows after a restart. "When you open it" doesn't grant the page you're on, as Chrome's click does |
| 15.07 | Private-mode extension permissions | ⏭️ | Private windows are the engine's private mode, where it doesn't run extensions and has no switch to let one in -- they stay out (Chrome's default) |
| 15.08 | Extension updates | ✅ | Settings -> Extensions -> Update now; a new version keeps the extension's data. One that asks for more than before waits for you to look it over |
| 15.09 | Automatic updates | ✅ | A little after starting, then every five hours (Settings -> Extensions can turn it off) |
| 15.10 | Extension developer mode | ✅ | Developer mode: load unpacked (your folder, never changed), Reload after editing, id shown. Manifest changes finish on the next start (the engine reads manifests then) |
| 15.11 | Extension debugging | 🟡 | Its options and popup pages open in a tab, where F12 DevTools works; why the engine won't run one is shown in Settings. Service workers can't be inspected (WebView2 has no chrome://inspect) |
| 15.12 | Extension packaging | ✅ | Pack for a store: a .zip the Chrome Web Store and Edge Add-ons take (without the key Kessel adds) |
| 15.13 | Extension themes | 🟡 | A Chrome theme's colours go onto the style you use (frame, toolbar, text, address bar, accent); its background pictures aren't used |
| 15.14 | Content blockers | 🟡 | Shields is built in. Manifest V3 blockers install and run -- tried with uBlock Origin Lite from the Chrome Web Store -- but WebView2 doesn't act on their blocking rules (enabled, and matching by its own test, yet requests go through), so Shields does the blocking |
| 15.15 | Password-manager extensions | 🟡 | Install and run like any MV3 extension (their popups from the puzzle button, content scripts fill forms) -- not tried with a real one yet; the built-in vault is Passwords |
| 15.16 | Productivity extensions | 🟡 | Install and run like any MV3 extension -- not tried with real ones yet. The engine has no chrome.tabs model of Kessel's tabs, so ones that manage tabs can't |
| 15.17 | Developer extensions | 🟡 | Install and run like any MV3 extension; DevTools extensions (devtools_page) don't, as WebView2's DevTools has no panels for them |

### 16. Built-in content blocking

| # | Feature | Status | Notes |
|---|---|---|---|
| 16.01 | Popup blocker | 🟢 | |
| 16.02 | Ad blocker | 🟢 | Shields |
| 16.03 | Tracker blocker | 🟢 | Shields |
| 16.04 | Cookie-consent blocker | 🟢 | Optional list (cookie notices) |
| 16.05 | Malicious-domain blocker | 🟢 | Shields lists |
| 16.06 | Social-widget blocker | 🟢 | Optional annoyances list |
| 16.07 | Cryptomining blocker | 🟢 | Shields lists |
| 16.08 | Fingerprinting protection | 🟢 | |
| 16.09 | Annoyance filter | 🟢 | Optional list |
| 16.10 | Autoplay blocker | ✅ | Settings -> Site permissions -> Sound playing on its own: block it for every site or one -- a page can't start sound before you've clicked there |
| 16.11 | Script blocking | ✅ | Site settings -> JavaScript: off for a site, or for every site (section 14) |
| 16.12 | Element blocking | 🟡 | Cosmetic filtering only ran on Kessel's own pages; element picker to do |
| 16.13 | Custom filter lists | ✅ | Settings -> Privacy -> Add list: your own filter list by its address, downloaded and refreshed like the others; remove it again |
| 16.14 | Allowlist | 🟢 | |
| 16.15 | Blocklist | 🟢 | |
| 16.16 | Per-site exceptions | 🟢 | |

### 17. Reading & research

| # | Feature | Status | Notes |
|---|---|---|---|
| 17.01 | Reader mode | ✅ | F9: the article on its own (reader.html), strictly rebuilt so nothing of the site runs |
| 17.02 | Reading list | ✅ | Side panel -> Reading list: unread/read, add the page you're on, or right-click a link: Add link to reading list |
| 17.03 | Save page for later | ✅ | Right-click a page: Add page to reading list |
| 17.04 | Offline pages | ✅ | A page put on the reading list while it's open is kept whole (the engine's web archive, MHTML) to read offline |
| 17.05 | Reading progress | 🧪 | Progress bar and minutes to read in reader view |
| 17.06 | Page translation | ✅ | Right-click the page -> Translate this page (Google Translate) |
| 17.07 | Dictionary | ✅ | Right-click a word -> Define (Wiktionary, else your search engine); in the address bar: define word (1.17) |
| 17.08 | Spell checker | ⏳ | |
| 17.09 | Grammar checking | ⏳ | |
| 17.10 | Text-to-speech | ✅ | Right-click selected text -> Read aloud (and Stop); Reader view -> Read aloud with your voice and speed |
| 17.11 | Page narration | 🧪 | Reader view reads the article paragraph by paragraph, highlighting each |
| 17.12 | Find in page | ✅ | Ctrl+F, the engine's own find bar |
| 17.13 | Find next/previous | ✅ | F3 / Ctrl+G, Shift+F3 / Ctrl+Shift+G |
| 17.14 | Search selected text | ✅ | Right-click selected text -> Search the web for… |
| 17.15 | Search image | ✅ | Right-click an image -> Search the web for this image (Google Lens, Bing, Yandex or TinEye) |
| 17.16 | Copy selected text | 🌐 | Comes with the engine (WebView2, Chromium) |
| 17.17 | Highlight text | ✅ | Select text, Ctrl+Shift+H or right-click -> Highlight; found again when you come back |
| 17.18 | Page annotations | 🧪 | Notes on highlights (click one); kept on this computer, never from private windows |
| 17.19 | Web clipping | 🟡 | Pick text, right-click: Save selection to notes -- kept with the page it came from (text only) |
| 17.20 | Print | ✅ | Ctrl+P and the menu: the engine's print preview |
| 17.21 | Save as PDF | 🧪 | Command palette -> Save as PDF; landscape, backgrounds, headers in Settings -> Page tools |
| 17.22 | Webpage screenshot | ✅ | Ctrl+Shift+S, or the whole page from the command palette |

### 18. Translation

| # | Feature | Status | Notes |
|---|---|---|---|
| 18.01 | Automatic language detection | 🟡 | Kessel reads the language the page declares (its lang or Content-Language), not the text itself |
| 18.02 | Full-page translation | ✅ | Right-click the page -> Translate this page: Google Translate's copy of it, in a new tab |
| 18.03 | Selected-text translation | ✅ | Right-click selected text -> Translate: Google, Microsoft Translator or DeepL, in a new tab |
| 18.04 | Translation popup | ✅ | A Translate chip in the address bar on a page in another language: translate it, Always, Never for the language or the site |
| 18.05 | Translation language preferences | ✅ | Settings -> Page tools: translate into Kessel's language or one you pick, and with which service |
| 18.06 | Automatic translation | ✅ | Always translate <language> from the chip: its pages go to the translator by themselves; removable in Settings -> Page tools |
| 18.07 | Never translate this language | ✅ | Never translate <language> from the chip; Settings -> Page tools lists them, each removable |
| 18.08 | Never translate this site | ✅ | Never translate <site> from the chip; Settings -> Page tools lists them, each removable |
| 18.09 | Offline translation | ⏳ | |
| 18.10 | Privacy-preserving translation | ⏳ | |

### 19. PDF

| # | Feature | Status | Notes |
|---|---|---|---|
| 19.01 | PDF viewer | 🌐 | The engine's own PDF viewer (Edge's) |
| 19.02 | PDF search | 🌐 | In the PDF viewer's toolbar |
| 19.03 | PDF zoom | 🌐 | In the PDF viewer's toolbar |
| 19.04 | PDF page navigation | 🌐 | In the PDF viewer's toolbar |
| 19.05 | PDF thumbnails | ⏳ | |
| 19.06 | PDF printing | 🌐 | In the PDF viewer's toolbar |
| 19.07 | PDF download | 🌐 | In the PDF viewer's toolbar |
| 19.08 | PDF save | 🌐 | In the PDF viewer's toolbar |
| 19.09 | PDF rotation | 🌐 | In the PDF viewer's toolbar |
| 19.10 | PDF text selection | 🌐 | Comes with the engine (WebView2, Chromium) |
| 19.11 | PDF copying | 🌐 | Comes with the engine (WebView2, Chromium) |
| 19.12 | PDF annotation | ⏳ | |
| 19.13 | PDF highlighting | ⏳ | |
| 19.14 | PDF drawing | ⏳ | |
| 19.15 | PDF form filling | 🌐 | The PDF viewer fills in PDF forms |
| 19.16 | PDF signing | ⏳ | |
| 19.17 | PDF editing | ⏳ | |
| 19.18 | PDF presentation mode | ⏳ | |

### 20. Media

| # | Feature | Status | Notes |
|---|---|---|---|
| 20.01 | HTML5 video | 🧪 | The engine's player; Kessel's media controls work with every `<video>` |
| 20.02 | HTML5 audio | ✅ | The engine's player; Kessel's media controls work with every `<audio>` |
| 20.03 | Media controls | ✅ | The music-note button beside the menu (shown once a tab has played sound): every such tab of the window with title, artist, artwork, play/pause, ±10 s, a seek bar, previous/next, mute -- without switching tabs. Also a command ("media controls") |
| 20.04 | Fullscreen video | 🟢 | A video's (or any page's) fullscreen fills the whole screen |
| 20.05 | Picture-in-picture | 🧪 | Media controls -> picture-in-picture: the engine's floating video window |
| 20.06 | Multiple audio tracks | 🧪 | Switched on in the engine (AudioVideoTracks); media controls -> audio track, when a video has more than one |
| 20.07 | Subtitles | ✅ | WebVTT subtitle tracks, drawn by the engine; media controls -> captions menu turns them on and off |
| 20.08 | Closed captions | ✅ | Caption tracks, like subtitles (20.07) |
| 20.09 | Playback speed | ✅ | Media controls -> speed: 0.5× to 3× (a site's own speed setting, 0.25× to 4×, is kept) |
| 20.10 | Media session controls | ✅ | The page's Media Session: its title, artist and artwork show in the media controls, and its own previous/next/seek buttons are what they press |
| 20.11 | Hardware acceleration | 🧪 | Video is decoded by the graphics card; kessel://gpu shows which formats are, on this PC |
| 20.12 | Codec support | 🧪 | The engine's: H.264, VP8, VP9, AV1, AAC, MP3, Opus, Vorbis, FLAC, WAV; HEVC where Windows and the graphics card have it. kessel://gpu lists what plays here |
| 20.13 | HDR | 🧪 | HDR video plays in HDR when Windows' HDR is on; kessel://gpu shows whether it is |
| 20.14 | Wide-color support | 🧪 | Display P3 / Rec. 2020 colour on screens that have it; kessel://gpu shows the screen's gamut |
| 20.15 | Spatial audio | 🟡 | 3D (HRTF) Web Audio and surround output work; Windows Sonic / Dolby Atmos are turned on in Windows. kessel://gpu shows the output channels |
| 20.16 | Web Audio | 🧪 | The engine's; kessel://gpu shows sample rate and latency |
| 20.17 | WebRTC | 🧪 | The engine's (video calls); a site asks before using the camera or microphone |
| 20.18 | Screen sharing | 🧪 | getDisplayMedia: the engine's screen / window / tab picker |
| 20.19 | Camera streaming | 🧪 | The engine's; a site asks first. kessel://gpu counts the cameras |
| 20.20 | Microphone streaming | 🧪 | The engine's; a site asks first. kessel://gpu counts the microphones |

### 21. Picture-in-picture

| # | Feature | Status | Notes |
|---|---|---|---|
| 21.01 | Video pop-out | 🧪 | Media controls -> picture-in-picture, or Alt+P: the engine's floating video window |
| 21.02 | Always-on-top video | 🧪 | The engine's picture-in-picture window stays on top of other windows |
| 21.03 | Resize PiP window | 🧪 | The picture-in-picture window resizes from its edges (the engine's own) |
| 21.04 | Move PiP window | 🧪 | The picture-in-picture window moves by dragging it (the engine's own) |
| 21.05 | Pause/play | 🧪 | Its own play/pause button; Kessel's media controls too |
| 21.06 | Next/previous | 🧪 | Its previous/next buttons when the page offers them (Media Session, 20.10) |
| 21.07 | Subtitle support | ⏳ | |
| 21.08 | Multiple PiP windows where supported | ⏭️ | The engine shows one picture-in-picture window at a time |

### 22. Accessibility

| # | Feature | Status | Notes |
|---|---|---|---|
| 22.01 | Page zoom | ✅ | The engine's real zoom, remembered per site; Settings -> Appearance: default zoom and each site's zoom |
| 22.02 | Text-only zoom | ✅ | Settings -> Accessibility -> Text size: the engine's own font size for each page -- the text grows, the layout and pictures don't; open pages follow at once |
| 22.03 | Minimum font size | ✅ | Settings -> Accessibility -> Smallest font size: text a page makes smaller is shown at that size, new text too |
| 22.04 | Custom fonts | ✅ | Settings -> Accessibility: your standard, sans-serif, serif and fixed-width fonts, for pages that don't choose their own |
| 22.05 | High-contrast compatibility | 🧪 | The engine follows Windows' contrast themes (forced colours) in pages and Kessel's own windows; untried with a contrast theme on. Also: the More contrast colour filter (22.14) |
| 22.06 | Reduced-motion support | ✅ | Settings -> Accessibility -> Less motion: pages hear prefers-reduced-motion and their animations and transitions stop; Kessel's own UI follows Windows' Animation effects |
| 22.07 | Screen-reader support | ✅ | The engine hands pages and Kessel's windows to screen readers (UI Automation); every button of Kessel's toolbar has a name to say (tested) |
| 22.08 | Keyboard navigation | ✅ | F6: the address bar; Shift+F6: the page; Alt+F / F10: the menu; F2: every command; Tab through Kessel's controls; every shortcut in Settings -> Keyboard & Mouse |
| 22.09 | Caret browsing | 🧪 | F7 or Settings -> Accessibility (after a restart): the engine's own caret browsing -- it reaches the engine (tested); moving the caret takes real keys to try |
| 22.10 | Focus indicators | ✅ | Kessel's own pages outline whatever has the keyboard; Settings -> Accessibility -> Always show where the keyboard is: a bold outline on every page |
| 22.11 | Text-to-speech | ✅ | Right-click selected text -> Read aloud; Reader view -> Read aloud |
| 22.12 | Caption support | ✅ | Media controls -> captions (20.07) |
| 22.13 | Accessibility tree | 🌐 | The engine's: F12 -> Elements -> Accessibility; pages have their tree (tested) |
| 22.14 | Color/contrast assistance | ✅ | Colour filters for every site or one: more contrast, grayscale, invert, dark, sepia, dimmer -- Settings -> Accessibility or Page tools |
| 22.15 | Keyboard shortcuts | ✅ | See the shortcut table above; the full list is in Help (F1) |
| 22.16 | Custom shortcut configuration | ✅ | Settings -> Keyboard & Mouse: press the keys you want; conflicts are shown; reset one or all |

### 23. Appearance

| # | Feature | Status | Notes |
|---|---|---|---|
| 23.01 | Light mode | 🟢 | |
| 23.02 | Dark mode | 🟢 | |
| 23.03 | System theme | 🟢 | Settings -> Appearance -> Mode: Follow Windows (changes along with Windows) |
| 23.04 | Custom themes | 🟢 | |
| 23.05 | Custom background | 🟢 | Wallpapers |
| 23.06 | Custom new-tab wallpaper | 🟢 | |
| 23.07 | Custom accent color | 🟢 | |
| 23.08 | Custom toolbar | ⏳ | |
| 23.09 | Toolbar button rearrangement | ⏳ | |
| 23.10 | Compact mode | ✅ | Settings -> Appearance -> Density: Compact -- smaller tab strip, toolbar, bookmarks bar, rail and menus, in any style |
| 23.11 | Normal mode | 🟢 | |
| 23.12 | Touch mode | ✅ | Settings -> Appearance -> Density: Touch -- tabs, buttons and menu items big enough for a finger |
| 23.13 | Sidebar | 🟢 | Rail + side panel |
| 23.14 | Vertical tabs | ✅ | See 2.30 |
| 23.15 | Custom fonts | ✅ | Settings -> Accessibility: your standard, sans-serif, serif and fixed-width fonts (22.04) |
| 23.16 | Custom UI scaling | 🟢 | Interface size |

### 24. Search engines

| # | Feature | Status | Notes |
|---|---|---|---|
| 24.01 | Default search engine | 🟢 | |
| 24.02 | Multiple search engines | 🟢 | Six built in |
| 24.03 | Custom search engines | ✅ | Settings -> Search & Startup: add, edit, remove engines (%s for the query); any can be the default |
| 24.04 | Search shortcuts (g cats, yt ..., wiki ...) | ✅ | Type a keyword and a space: yt cats, w Budapest, !gh kessel; keywords are yours to change |
| 24.05 | Search suggestions | 🟢 | As you type in the address bar (Settings -> Search & Startup); never from a private window |
| 24.06 | Search history | ✅ | History -> Searches: what you searched, on which engine (5.12) |
| 24.07 | Private search | ✅ | Settings -> Search & Startup -> In private windows: a search engine of its own there |
| 24.08 | Search engine per profile | ✅ | Each profile keeps its own default and own search engines (8.14) |
| 24.09 | Search engine per window | ⏳ | |

### 25. Startup behavior

| # | Feature | Status | Notes |
|---|---|---|---|
| 25.01 | Open new-tab page | 🟢 | |
| 25.02 | Open homepage | 🟢 | |
| 25.03 | Open specific pages | ✅ | Settings -> Search & Startup -> Pages to start with (or your open tabs) |
| 25.04 | Restore previous session | 🟢 | |
| 25.05 | Restore selected windows | 🟡 | Every window of the last session comes back; a saved session can open just one of its windows |
| 25.06 | Open specific profile | ✅ | A profile's desktop shortcut, or kessel.exe --profile <name>, opens straight into it |
| 25.07 | Continue where you left off | 🟢 | |
| 25.08 | Startup tab groups | ✅ | A saved session to start with brings its tab groups back (25.09) |
| 25.09 | Startup workspace | ✅ | Settings -> Search & Startup -> Or a saved session: its windows, tabs, groups and workspaces every time Kessel starts |

### 26. Session management

| # | Feature | Status | Notes |
|---|---|---|---|
| 26.01 | Save session | ✅ | Each window's tabs are saved as they change (3.10) |
| 26.02 | Restore session | ✅ | The last session on launch, or any saved session whenever you like (26.05) |
| 26.03 | Automatic session recovery | ✅ | Tabs are saved as they change; after a crash they come back by themselves (Keep tabs when Kessel closes, or the engine crashing) or are offered (54.03) |
| 26.04 | Crash recovery | ✅ | The toolbar watchdog, crashed pages and the engine itself (section 54) |
| 26.05 | Session snapshots | ✅ | Save all windows (or just this one) as a session; History -> Saved sessions opens, renames and deletes them |
| 26.06 | Save window | ✅ | Save this window as a session (26.05); it's also saved with the session as it changes |
| 26.07 | Restore window | ✅ | Reopen closed window, any of them from History -> Recently closed, or a saved window |
| 26.08 | Suspend session | 🟢 | Tab menu -> Put other tabs to sleep; the task manager puts any tab to sleep and wakes it |
| 26.09 | Export session | ✅ | See 52.17 |
| 26.10 | Import session | 🟡 | The saved file imports as bookmarks (a folder per window); Open all reopens a window |
| 26.11 | Cross-device session restore | ⏭️ | Needs an online account or server: left out |

### 27. Browser workspaces

| # | Feature | Status | Notes |
|---|---|---|---|
| 27.01 | Workspace creation | ✅ | The side panel's Workspaces page, or Settings -> Side panel: a name, an icon and a colour |
| 27.02 | Workspace switching | ✅ | The workspace buttons at the top of the rail (right-click for more), or the side panel |
| 27.03 | Workspace tabs | ✅ | Each window shows one workspace's tabs; the others' tabs sleep (no memory) until you come back. The tab menu moves tabs between them |
| 27.04 | Workspace-specific themes | 🟡 | A workspace's colour is its window's accent while you're in it |
| 27.05 | Workspace-specific tab groups | ✅ | Tab groups go with their workspace's tabs |
| 27.06 | Workspace persistence | ✅ | Every window's workspaces and their tabs come back with the session (Keep tabs when Kessel closes) |
| 27.07 | Workspace sync | ⏭️ | Needs a sync server Kessel doesn't have |

### 28. Sidebar

| # | Feature | Status | Notes |
|---|---|---|---|
| 28.01 | Bookmarks | ✅ | Side panel -> Bookmarks: search, open (Ctrl/middle click: new tab), add the page you're on, remove |
| 28.02 | History | ✅ | Side panel -> History: by day, search, open, remove, more as you scroll |
| 28.03 | Downloads | 🟢 | |
| 28.04 | Reading list | ✅ | Side panel -> Reading list |
| 28.05 | Notes | ✅ | Side panel -> Notes: write, pin, link to the page you're on, search; saved as you type |
| 28.06 | AI assistant | ✅ | ChatGPT, Claude, Gemini, Copilot, Perplexity, Le Chat or your own (Settings -> Side panel) in the side panel; right-click "Ask AI about this" asks it |
| 28.07 | Messaging services | 🟢 | Any pinned site opens in the side panel |
| 28.08 | Web apps | 🟢 | Pinned sites |
| 28.09 | Extensions | ✅ | Side panel -> Extensions; an extension's side panel page (or popup) opens in the side panel |
| 28.10 | Search | ✅ | Side panel -> Search: open tabs, bookmarks, reading list, notes and history at once; Enter searches the web in the side panel |
| 28.11 | Workspaces | ✅ | Side panel -> Workspaces, and their buttons at the top of the rail |

### 29. Developer tools

| # | Feature | Status | Notes |
|---|---|---|---|
| 29.01 | Elements: HTML inspector, DOM tree | 🌐 | Edge DevTools (F12) |
| 29.02 | Elements: CSS inspector, CSS editing, computed styles | 🌐 | Edge DevTools (F12) |
| 29.03 | Elements: box model, layout, flexbox and grid inspectors | 🌐 | Edge DevTools (F12) |
| 29.04 | Elements: accessibility tree | 🌐 | Edge DevTools (F12) |
| 29.05 | Console: JavaScript console, logs, errors, warnings, stack traces, command execution | 🌐 | Edge DevTools (F12) |
| 29.06 | Network: request list, response, headers, cookies, timing, waterfall | 🌐 | Edge DevTools (F12) |
| 29.07 | Network: request blocking, throttling, HAR export | 🌐 | Edge DevTools (F12) |
| 29.08 | Performance: CPU profiling, rendering, memory, frame rate, timeline, long tasks | 🌐 | Edge DevTools (F12) |
| 29.09 | Storage: cookies, localStorage, sessionStorage, IndexedDB, Cache Storage, service workers, WebSQL | 🌐 | Edge DevTools (F12) |
| 29.10 | Application: manifest, service workers, cache, storage, permissions, background services | 🌐 | Edge DevTools (F12) |
| 29.11 | Debugging: breakpoints, conditional breakpoints, watch, call stack, source maps | 🌐 | Edge DevTools (F12) |

### 30. Web platform support

| # | Feature | Status | Notes |
|---|---|---|---|
| 30.01 | JavaScript: modern ECMAScript, Web/Shared/Service Workers, WebAssembly | 🌐 | Comes with the engine (WebView2, Chromium) |
| 30.02 | Graphics: Canvas, WebGL, WebGL2, WebGPU, SVG, CSS animations and transitions | 🌐 | Comes with the engine (WebView2, Chromium) |
| 30.03 | Storage: cookies, localStorage, sessionStorage, IndexedDB, Cache API, File System Access | 🌐 | Comes with the engine (WebView2, Chromium) |
| 30.04 | Communication: WebSockets, WebRTC, WebTransport, Server-Sent Events, Fetch, Streams | 🌐 | Comes with the engine (WebView2, Chromium) |
| 30.05 | Hardware: camera, microphone, Bluetooth, USB, HID, Serial, MIDI, NFC, sensors | 🟡 | Camera, microphone, MIDI and sensors (with Site permissions); WebView2 has no Bluetooth, USB, HID, Serial or NFC device pickers |
| 30.06 | OS integration: clipboard, notifications, file picker, Share API, fullscreen, Wake Lock, Badging, credential management | 🌐 | Comes with the engine (WebView2, Chromium); notifications and clipboard go through Site permissions |

### 31. Progressive Web Apps

| # | Feature | Status | Notes |
|---|---|---|---|
| 31.01 | Install website as app | ⏳ | |
| 31.02 | PWA manifest | ⏳ | |
| 31.03 | App icon | ⏳ | |
| 31.04 | Standalone mode | ⏳ | |
| 31.05 | Offline functionality | 🌐 | A site's service worker keeps it working offline (37.09, tested) |
| 31.06 | Push notifications | ⏭️ | WebView2 has no push service: a push subscription never gets an answer (tested) |
| 31.07 | Background sync | 🌐 | Background sync: a site's service worker syncs once it's online (tested) |
| 31.08 | Periodic background tasks | ⏳ | |
| 31.09 | App shortcuts | ⏳ | |
| 31.10 | Badges | ⏳ | |
| 31.11 | Launch handling | ⏳ | |
| 31.12 | Share integration | ⏳ | |
| 31.13 | File handling | ⏳ | |
| 31.14 | Protocol handling | ⏳ | |
| 31.15 | URL handling | ⏳ | |

### 32. Notifications

| # | Feature | Status | Notes |
|---|---|---|---|
| 32.01 | Website notifications | ⏳ | |
| 32.02 | Permission prompts | ✅ | Kessel's own prompt under the address bar |
| 32.03 | Notification blocking | 🧪 | Site permissions -> Notifications: Block, for every site or one |
| 32.04 | Per-site notification permissions | ✅ | Settings -> Site permissions -> Notifications, per site |
| 32.05 | Notification history | ⏳ | |
| 32.06 | Push notifications | ⏭️ | WebView2 has no push service (31.06) |
| 32.07 | Notification sounds | ⏳ | |
| 32.08 | Notification actions | ⏳ | |
| 32.09 | Notification grouping | ⏳ | |
| 32.10 | Quiet notification prompts | ⏳ | |

### 33. Clipboard

| # | Feature | Status | Notes |
|---|---|---|---|
| 33.01 | Copy | 🌐 | Comes with the engine (WebView2, Chromium) |
| 33.02 | Paste | 🌐 | Comes with the engine (WebView2, Chromium) |
| 33.03 | Cut | 🌐 | Comes with the engine (WebView2, Chromium) |
| 33.04 | Rich-text clipboard | 🌐 | Comes with the engine (WebView2, Chromium) |
| 33.05 | Image clipboard | 🌐 | Comes with the engine (WebView2, Chromium) |
| 33.06 | Clipboard permissions | 🧪 | Settings -> Site permissions -> Reading what you copied |
| 33.07 | Clipboard history integration | 🌐 | Windows' clipboard history (Win+V) sees everything Kessel copies |

### 34. File system

| # | Feature | Status | Notes |
|---|---|---|---|
| 34.01 | File picker | 🌐 | Comes with the engine (WebView2, Chromium) |
| 34.02 | Folder picker | 🌐 | Comes with the engine (WebView2, Chromium) |
| 34.03 | Drag-and-drop files | 🌐 | Comes with the engine (WebView2, Chromium) |
| 34.04 | Upload directories | 🌐 | Comes with the engine (WebView2, Chromium) |
| 34.05 | Save file dialog | 🌐 | Comes with the engine (WebView2, Chromium) |
| 34.06 | File System Access API | 🌐 | Comes with the engine (WebView2, Chromium); editing files asks first (Site permissions) |
| 34.07 | File reading | 🌐 | Comes with the engine (WebView2, Chromium) |
| 34.08 | File writing | 🌐 | Comes with the engine (WebView2, Chromium) |
| 34.09 | File handles | 🌐 | Comes with the engine (WebView2, Chromium) |
| 34.10 | Persistent file permissions | ⏳ | |

### 35. Hardware acceleration

| # | Feature | Status | Notes |
|---|---|---|---|
| 35.01 | GPU rendering | ✅ | On by default; Settings -> Performance -> Use hardware acceleration (off draws everything with the processor; applies at the next start) |
| 35.02 | Hardware video decoding | 🧪 | kessel://gpu: for each video format, whether the graphics card or the processor decodes it |
| 35.03 | Hardware video encoding | 🧪 | Used by video calls; kessel://gpu shows which formats the graphics card encodes |
| 35.04 | WebGL acceleration | 🧪 | kessel://gpu shows the renderer and warns about a software fallback |
| 35.05 | WebGPU | 🧪 | The engine's WebGPU; kessel://gpu shows the power-saving and high-performance adapters |
| 35.06 | GPU rasterization | 🧪 | The engine's, with hardware acceleration on |
| 35.07 | Compositor acceleration | 🧪 | The engine's, with hardware acceleration on (off: software compositing) |
| 35.08 | Battery-aware GPU behavior | 🟡 | Settings -> Performance -> Graphics card: Automatic picks the power-saving card when Kessel starts on battery -- decided at start, not while running; or always power-saving / high-performance |
| 35.09 | Graphics diagnostics | ✅ | kessel://gpu (Settings -> Performance, Help, or type "gpu" in the address bar): acceleration, renderer, WebGL/WebGPU, display, video and audio formats, DRM, Web Audio, WebRTC; Copy report |

### 36. Performance

| # | Feature | Status | Notes |
|---|---|---|---|
| 36.01 | Memory saver | ✅ | Sleeping tabs and "Save memory in background tabs" (2.39, 2.44); Settings -> Performance |
| 36.02 | Sleeping tabs | 🟢 | |
| 36.03 | Energy saver | ⏳ | |
| 36.04 | CPU throttling | ✅ | Background tabs are paused after a while (2.41) |
| 36.05 | Background-tab throttling | ✅ | See 2.44 |
| 36.06 | Hardware acceleration | ✅ | See 35.01 |
| 36.07 | Cache optimization | ⏳ | |
| 36.08 | Prefetching | 🌐 | <link rel=prefetch>: the engine fetches the page ahead (tested) |
| 36.09 | Pre-rendering | 🌐 | Speculation rules: a page a site asks to prerender is fetched ahead, and following the link needs no new request (tested) |
| 36.10 | DNS caching | 🌐 | The engine's (Chromium's) network stack |
| 36.11 | Connection reuse | 🌐 | The engine's network stack |
| 36.12 | HTTP/2 multiplexing | 🌐 | The engine's network stack |
| 36.13 | HTTP/3/QUIC | 🌐 | The engine's network stack |
| 36.14 | Image optimization | ⏳ | |
| 36.15 | Lazy loading | 🌐 | loading="lazy" images and frames |
| 36.16 | Process management | ✅ | kessel://tasks: every process; end one (40.05) |
| 36.17 | Site isolation | 🌐 | The engine's site isolation |

### 37. Cache

| # | Feature | Status | Notes |
|---|---|---|---|
| 37.01 | HTTP cache | 🌐 | |
| 37.02 | Memory cache | 🌐 | |
| 37.03 | Disk cache | 🌐 | |
| 37.04 | Cache inspection | 🌐 | DevTools (F12) -> Application: cache storage, service workers and site storage; Network shows what came from the cache |
| 37.05 | Cache clearing | ✅ | Clear browsing data -> Cached images and files, for a time range |
| 37.06 | Per-site cache deletion | 🟡 | The lock -> site data: a site's storage, service-worker caches and cookies go; the engine's HTTP cache only clears whole (Clear browsing data) |
| 37.07 | Full cache deletion | ✅ | Clear browsing data -> All time |
| 37.08 | Cache-control handling | 🌐 | Ctrl+F5 skips it |
| 37.09 | Offline cache | 🌐 | A site's service worker keeps pages in its cache; they open with the site gone (tested) |
| 37.10 | Service-worker cache | 🌐 | The Cache API in pages and service workers (tested) |

### 38. Developer / experimental controls

| # | Feature | Status | Notes |
|---|---|---|---|
| 38.01 | Experimental features | 🟡 | Settings -> Network -> Engine switches (your own Chromium switches) |
| 38.02 | Feature flags | ✅ | Settings -> Network -> Engine switches: --enable-features / --disable-features |
| 38.03 | Browser experiments | ⏳ | |
| 38.04 | Experimental APIs | ⏳ | |
| 38.05 | Rendering flags | 🧪 | Any rendering switch in Settings -> Network -> Engine switches |
| 38.06 | GPU flags | 🧪 | Any GPU switch in Settings -> Network -> Engine switches |
| 38.07 | Networking flags | 🧪 | Any networking switch in Settings -> Network -> Engine switches |
| 38.08 | JavaScript flags | 🧪 | --js-flags in Settings -> Network -> Engine switches |
| 38.09 | Developer mode | ⏳ | |
| 38.10 | Internal diagnostics | ✅ | kessel://diagnostics, kessel://gpu and kessel://tasks |
| 38.11 | Browser logs | ⏳ | |
| 38.12 | Crash logs | ✅ | crashes.json, in kessel://diagnostics (54.04) |
| 38.13 | Performance diagnostics | ✅ | kessel://tasks (CPU and memory per process, every 2 s) and DevTools' Performance panel (F12) |

### 39. Browser information & diagnostics

| # | Feature | Status | Notes |
|---|---|---|---|
| 39.01 | Browser version | 🟢 | Settings -> About |
| 39.02 | Engine version | ✅ | Help and Settings -> About show the WebView2 version |
| 39.03 | OS information | ✅ | kessel://diagnostics: Windows' name, version (25H2...) and build, and the architecture |
| 39.04 | GPU information | 🧪 | kessel://gpu: the renderer, WebGL and WebGPU adapters |
| 39.05 | CPU information | ✅ | kessel://diagnostics: the processor's name and its threads |
| 39.06 | Memory information | ✅ | kessel://diagnostics: the PC's memory and how much is free; kessel://tasks: each process's |
| 39.07 | Installed codecs | ✅ | kessel://gpu: video and audio formats, hardware decoding, DRM |
| 39.08 | Supported APIs | ✅ | kessel://diagnostics -> Web features: 37 tried in the engine itself, with what WebView2 only half-supports (no device chooser, no push service) |
| 39.09 | Network information | ✅ | kessel://diagnostics -> Network: online or not, the engine's speed estimate, the proxy in use |
| 39.10 | Connection status | ✅ | kessel://diagnostics: online / offline, updated as it changes |
| 39.11 | Crash reports | ✅ | kessel://diagnostics -> Crash reports: every crash of a page, the engine, Kessel itself or a damaged data file (54.04) |
| 39.12 | Diagnostics page | ✅ | kessel://diagnostics (palette: Diagnostics): Kessel, this PC, network, storage, crash reports, web features; Copy report. kessel://gpu for graphics and media |
| 39.13 | Certificate information | 🟢 | The lock -> Certificate: Windows' certificate viewer for the site |
| 39.14 | Storage usage | ✅ | kessel://diagnostics -> Storage: the room Kessel's own data and sites' data (cookies, cache, site storage) take, per account |
| 39.15 | Site permissions | 🟢 | Settings -> Site permissions, and the lock's Site settings (sections 13, 14) |
| 39.16 | Process manager | ✅ | Shift+Esc: Kessel's task manager (kessel://tasks); the engine's own is a button away |

### 40. Built-in task management

| # | Feature | Status | Notes |
|---|---|---|---|
| 40.01 | Tab CPU usage | ✅ | kessel://tasks: each page's process with its tabs, CPU and memory (hover cards show a tab's too) |
| 40.02 | Tab RAM usage | ✅ | kessel://tasks: each page's process with its tabs, CPU and memory |
| 40.03 | Extension CPU usage | 🧪 | kessel://tasks: extensions' processes (named when one of its pages is open); not yet checked with an extension's background page |
| 40.04 | Extension RAM usage | 🧪 | As 40.03 |
| 40.05 | Process termination | ✅ | kessel://tasks -> End process (not the engine's main one); the pages in it show they crashed, with Reload |
| 40.06 | Suspended-tab management | ✅ | kessel://tasks: the tabs asleep, to wake or close; any tab to sleep from there |
| 40.07 | GPU process information | ✅ | kessel://tasks: the graphics process, its memory and CPU; End process |
| 40.08 | Network process information | ✅ | kessel://tasks: the network service and the engine's other helpers, named by their job |
| 40.09 | Browser process information | ✅ | kessel://tasks: Kessel itself and the engine's main process (each account's own) |

### 41. Screenshots & capture

| # | Feature | Status | Notes |
|---|---|---|---|
| 41.01 | Full-page screenshot | ✅ | Command palette -> Screenshot of the whole page |
| 41.02 | Visible-area screenshot | ✅ | Ctrl+Shift+S |
| 41.03 | Selected-area screenshot | ✅ | Command palette -> Screenshot of a part of the page: drag a box |
| 41.04 | Screenshot to clipboard | 🧪 | Settings -> Page tools: save, copy or both |
| 41.05 | Screenshot annotation | 🧪 | Screenshot editor: pen, highlighter, arrows, boxes, text, blur, crop, undo/redo |
| 41.06 | Screen recording | ⏳ | |
| 41.07 | Tab recording | ⏳ | |
| 41.08 | Window recording | ⏳ | |
| 41.09 | Webcam recording | ⏳ | |
| 41.10 | Audio recording | ⏳ | |
| 41.11 | Developer screenshot tools | ⏳ | |

### 42. Sharing

| # | Feature | Status | Notes |
|---|---|---|---|
| 42.01 | Share current page | 🟢 | The share button in the address bar: copy the link, the QR code, a Markdown link, or Windows' Share window |
| 42.02 | Share selected text | 🧪 | Right-click selected text -> Share…: Windows' Share window with the text; not tried (it opens Windows' own window) |
| 42.03 | Share image | ⏳ | |
| 42.04 | Share file | ⏳ | |
| 42.05 | OS share sheet | 🧪 | The share button -> Share…: Windows' Share window; not tried (it opens Windows' own window) |
| 42.06 | QR-code sharing | 🟢 | The share button: the page's QR code, to copy as a picture (tested) |
| 42.07 | Send to another device | ⏭️ | Needs an online account or server: left out |
| 42.08 | Send tab to phone | ⏭️ | Needs an online account or server: left out |
| 42.09 | Send tab to computer | ⏭️ | Needs an online account or server: left out |

### 43. Mobile-specific features

| # | Feature | Status | Notes |
|---|---|---|---|
| 43.01 | Bottom address bar | 🧪 | Kessel for phones: the address bar at the bottom (or the top, Settings), menus and sheets rising from the bottom |
| 43.02 | One-handed mode | 🟡 | Everything within a thumb's reach from the bottom bar and sheets; no mode that shrinks the screen |
| 43.03 | Gesture navigation | 🧪 | Android's Back: menus first, then the page's history, then the tab that opened it; swipe along the address bar to change tabs; swipe a tab card to close it |
| 43.04 | Pull-to-refresh | ⏳ | Reload is in the menu |
| 43.05 | Tab grid | 🧪 | The tab switcher: a grid of tabs with pictures of them, normal and private |
| 43.06 | Tab groups | ⏳ | The desktop's groups aren't on the phone yet |
| 43.07 | Mobile tab synchronization | ⏭️ | Needs an account and sync server Kessel doesn't have |
| 43.08 | Send tab to desktop | ⏭️ | Needs sync; Share sends a link to any app or nearby device |
| 43.09 | Mobile downloads | 🧪 | To the phone's Downloads folder with Android's download manager; data: and blob: files too; a Downloads list |
| 43.10 | Mobile reader mode | ⏳ | |
| 43.11 | Mobile screenshot | ⏳ | |
| 43.12 | Mobile sharing | 🧪 | Android's share sheet for the page, a link or a picture |
| 43.13 | Mobile autofill | 🧪 | Android's autofill service (Google, a password manager app) fills pages' forms; the desktop's vault stays on the desktop |
| 43.14 | Mobile passkeys | ⏳ | |
| 43.15 | Biometric browser locking | ⏳ | |

### 44. Desktop-specific features

| # | Feature | Status | Notes |
|---|---|---|---|
| 44.01 | Multiple windows | ✅ | See 3.01 |
| 44.02 | Keyboard shortcuts | ✅ | See the shortcut table |
| 44.03 | Full developer tools | 🌐 | Edge DevTools (F12) |
| 44.04 | Extensions | 🟢 | Section 30: Chrome Web Store, Edge Add-ons, unpacked; turned on, off, updated |
| 44.05 | Vertical tabs | ✅ | See 2.30 |
| 44.06 | Sidebars | 🟢 | |
| 44.07 | Workspaces | 🟢 | The side panel's workspaces: their own tabs, asleep while you're away (tested) |
| 44.08 | Profiles | 🟡 | Accounts |
| 44.09 | Window management | 🟢 | Several windows, tabs dragged between them, pop-out windows, closed windows reopened (section 3) |
| 44.10 | Desktop notifications | ⏳ | |
| 44.11 | Hardware acceleration | ✅ | See 35.01 |
| 44.12 | Advanced downloads | 🟢 | The download manager: pause, resume, try again, search, sort, ask where to save (section 6) |
| 44.13 | Advanced DevTools | 🌐 | Edge DevTools (F12) |

### 45. Keyboard shortcuts

| # | Feature | Status | Notes |
|---|---|---|---|
| 45.01 | New tab | ✅ | Ctrl+T |
| 45.02 | Close tab | ✅ | Ctrl+W, Ctrl+F4 |
| 45.03 | Reopen tab | ✅ | Ctrl+Shift+T |
| 45.04 | New window | ✅ | Ctrl+N |
| 45.05 | Private window | ✅ | Ctrl+Shift+N |
| 45.06 | Next tab | ✅ | Ctrl+Tab, Ctrl+PageDown |
| 45.07 | Previous tab | ✅ | Ctrl+Shift+Tab, Ctrl+PageUp |
| 45.08 | Jump to tab | ✅ | Ctrl+1 ... 8, Ctrl+9 for the last |
| 45.09 | New profile | ✅ | Ctrl+Shift+M: Settings -> Profiles -- open another or make one |
| 45.10 | Search | ✅ | Ctrl+E, Ctrl+K |
| 45.11 | Find | ✅ | Ctrl+F, F3 |
| 45.12 | Zoom | ✅ | Ctrl +/-, Ctrl + wheel |
| 45.13 | Reset zoom | ✅ | Ctrl+0 |
| 45.14 | Reload | ✅ | F5, Ctrl+R |
| 45.15 | Hard reload | ✅ | Ctrl+F5, Shift+F5 |
| 45.16 | Back | ✅ | Alt+Left |
| 45.17 | Forward | ✅ | Alt+Right |
| 45.18 | Bookmark | ✅ | Ctrl+D |
| 45.19 | History | ✅ | Ctrl+H |
| 45.20 | Downloads | ✅ | Ctrl+J |
| 45.21 | Developer tools | ✅ | F12 |
| 45.22 | Fullscreen | ✅ | F11 |
| 45.23 | Picture-in-picture | 🧪 | Alt+P (or the command palette): the tab's video in picture-in-picture and back; the key is tested, the window itself waits for a run on screen |
| 45.24 | Screenshot | ✅ | Ctrl+Shift+S; PNG or JPEG, folder of your choice |
| 45.25 | Tab switching | ✅ | Ctrl+Tab, Ctrl+1 ... 9 |
| 45.26 | Tab movement | ✅ | Ctrl+Shift+PageUp / PageDown |
| 45.27 | Tab grouping | ✅ | See 2.19 |
| 45.28 | Custom keyboard shortcuts | ✅ | Settings -> Keyboard & Mouse |

### 46. Mouse / trackpad

| # | Feature | Status | Notes |
|---|---|---|---|
| 46.01 | Middle-click new tab | ✅ | Behind the current tab by default (Settings -> Keyboard & Mouse) |
| 46.02 | Middle-click close tab | 🟢 | |
| 46.03 | Ctrl-click links | ✅ | Ctrl+click: new tab; Ctrl+Shift+click: behind; Shift+click: new window |
| 46.04 | Drag links | ⏳ | |
| 46.05 | Drag tabs | 🟢 | |
| 46.06 | Mouse gestures | ✅ | Right button + draw; every gesture and its command is yours to change (Settings -> Page tools) |
| 46.07 | Trackpad gestures | ⏳ | |
| 46.08 | Two-finger navigation | ⏳ | |
| 46.09 | Pinch zoom | ✅ | Pinch on a touchpad or touchscreen: the engine's zoom, kept per site (22.01) |
| 46.10 | Swipe navigation | ⏳ | |
| 46.11 | Context menus | 🌐 | On pages: the engine's menu; on tabs, groups and the tab strip: Kessel's own (2.x) |
| 46.12 | Link preview | ✅ | Right-click a link -> Peek at link |

### 47. Context menus

| # | Feature | Status | Notes |
|---|---|---|---|
| 47.01 | Page: back, forward, reload | 🌐 | The engine's page menu |
| 47.02 | Page: save, print | 🌐 | The engine's page menu: Save as, Print |
| 47.03 | Page: translate, screenshot | ✅ | The page's right-click menu: Translate this page (Google Translate, into your language or the one you pick in Settings -> Page tools), Take a screenshot |
| 47.04 | Link: open in new tab / new window / private window | ✅ | Right-click a link: Open link in new tab (in front or behind, like Ctrl+click), in new window, in private window -- in place of the engine's own new-window item |
| 47.05 | Link: copy link, copy link text | ✅ | Right-click a link: Copy link (the engine's), Copy link text (Kessel's) |
| 47.06 | Link: download linked file, search link | ✅ | Right-click a link: Save link as (the engine's: a download), Search the web for its text |
| 47.07 | Text: copy, search | ✅ | Right-click selected text: Copy (the engine's), Search the web for it |
| 47.08 | Text: translate, define, speak, share | ✅ | Right-click selected text: Translate (Google, Microsoft or DeepL), Define (Wiktionary, else your search engine), Read aloud / Stop reading aloud (the reader view's voice), Share (Windows' Share window) |
| 47.09 | Image: open, save, copy, copy address | ✅ | Right-click an image: Open image in new tab (Kessel's), Save image as, Copy image, Copy image link (the engine's) |
| 47.10 | Image: search image | ✅ | Right-click an image: Search the web for this image (Google Lens, Bing, Yandex or TinEye) |

### 48. AI features

| # | Feature | Status | Notes |
|---|---|---|---|
| 48.01 | AI page summarization | 🟡 | Right-click a page: Ask AI about this page -- your assistant (side panel) is asked to summarize it |
| 48.02 | AI webpage explanation | 🟡 | The same, then ask it anything about the page |
| 48.03 | Ask about selected text | ✅ | Pick text, right-click: Ask AI about this -- the text goes to your assistant |
| 48.04 | AI search | ⏭️ | Needs an AI service account (the side panel's AI assistant is the account-free part): left out |
| 48.05 | AI tab organization | ⏭️ | Needs an AI service account (the side panel's AI assistant is the account-free part): left out |
| 48.06 | AI tab grouping | ⏭️ | Needs an AI service account (the side panel's AI assistant is the account-free part): left out |
| 48.07 | AI history search | ⏭️ | Needs an AI service account (the side panel's AI assistant is the account-free part): left out |
| 48.08 | AI browsing assistant | ✅ | Your AI assistant in the side panel, beside the page |
| 48.09 | AI writing assistant | ⏭️ | Needs an AI service account (the side panel's AI assistant is the account-free part): left out |
| 48.10 | AI rewriting | ⏭️ | Needs an AI service account (the side panel's AI assistant is the account-free part): left out |
| 48.11 | AI translation | ⏭️ | Needs an AI service account (the side panel's AI assistant is the account-free part): left out |
| 48.12 | AI comparison | ⏭️ | Needs an AI service account (the side panel's AI assistant is the account-free part): left out |
| 48.13 | AI shopping assistance | ⏭️ | Needs an AI service account (the side panel's AI assistant is the account-free part): left out |
| 48.14 | AI research mode | ⏭️ | Needs an AI service account (the side panel's AI assistant is the account-free part): left out |
| 48.15 | AI webpage extraction | ⏭️ | Needs an AI service account (the side panel's AI assistant is the account-free part): left out |
| 48.16 | AI PDF summarization | ⏭️ | Needs an AI service account (the side panel's AI assistant is the account-free part): left out |
| 48.17 | AI screenshot understanding | ⏭️ | Needs an AI service account (the side panel's AI assistant is the account-free part): left out |
| 48.18 | AI image understanding | ⏭️ | Needs an AI service account (the side panel's AI assistant is the account-free part): left out |
| 48.19 | AI command interface | ⏭️ | Needs an AI service account (the side panel's AI assistant is the account-free part): left out |
| 48.20 | Natural-language browser commands | ⏭️ | Needs an AI service account (the side panel's AI assistant is the account-free part): left out |

### 49. Shopping

| # | Feature | Status | Notes |
|---|---|---|---|
| 49.01 | Price comparison | ⏭️ | Needs a shopping data service: left out |
| 49.02 | Price tracking | ⏭️ | Needs a shopping data service: left out |
| 49.03 | Price history | ⏭️ | Needs a shopping data service: left out |
| 49.04 | Coupon detection | ⏭️ | Needs a shopping data service: left out |
| 49.05 | Automatic coupon application | ⏭️ | Needs a shopping data service: left out |
| 49.06 | Product comparison | ⏭️ | Needs a shopping data service: left out |
| 49.07 | Shopping lists | ⏳ | |
| 49.08 | Store credibility information | ⏭️ | Needs a shopping data service: left out |
| 49.09 | Purchase history integration | ⏭️ | Needs an online account or server: left out |
| 49.10 | Delivery tracking | ⏭️ | Needs an online account or server: left out |

### 50. Media & entertainment extras

| # | Feature | Status | Notes |
|---|---|---|---|
| 50.01 | Video enhancement | ⏳ | |
| 50.02 | Picture-in-picture | 🧪 | Media controls -> picture-in-picture, or Alt+P (20.05) |
| 50.03 | Playback controls | ✅ | Kessel's media controls (20.03): play/pause, ±10 s, a seek bar, speed, previous/next, for any tab without switching to it |
| 50.04 | Volume normalization | ⏳ | |
| 50.05 | Media-key support | ⏳ | |
| 50.06 | Casting | ⏭️ | WebView2 has no casting (Edge's cast needs Google's cast service): left out |
| 50.07 | Chromecast-style casting | ⏭️ | WebView2 has no casting (Edge's cast needs Google's cast service): left out |
| 50.08 | AirPlay-style integration | ⏭️ | WebView2 has no casting (Edge's cast needs Google's cast service): left out |
| 50.09 | Subtitle customization | ✅ | Settings -> Accessibility -> Subtitles: a video's captions larger, in another colour, on another background -- on every site |
| 50.10 | Theater mode | ✅ | Command palette -> Theater mode: the video fills the tab on black; Esc puts it back |
| 50.11 | Fullscreen mode | ✅ | F11 for the window; a video's own full screen button fills the whole screen and comes back as it was |

### 51. Privacy-focused advanced features

| # | Feature | Status | Notes |
|---|---|---|---|
| 51.01 | Tor-style routing integration | ⏭️ | Needs the Tor network (a separate program): left out |
| 51.02 | Private windows with stronger isolation | ⏳ | |
| 51.03 | Fingerprint resistance | 🟢 | |
| 51.04 | Tracker blocking | 🟢 | |
| 51.05 | Ad blocking | 🟢 | |
| 51.06 | Cookie isolation | 🟢 | Accounts |
| 51.07 | Container tabs | 🟢 | Accounts |
| 51.08 | Temporary identities | ⏳ | |
| 51.09 | Temporary email integration | ⏭️ | Needs an online account or server: left out |
| 51.10 | VPN integration | ⏭️ | Needs an online account or server: left out |
| 51.11 | Proxy integration | ⏳ | |
| 51.12 | Encrypted DNS | ⏳ | |
| 51.13 | Anti-bounce tracking | ⏳ | |
| 51.14 | URL tracking-parameter removal | 🟢 | |

### 52. Import / export

| # | Feature | Status | Notes |
|---|---|---|---|
| 52.01 | Import bookmarks | 🟢 | |
| 52.02 | Import history | ✅ | Chrome, Edge, Brave, Opera, Vivaldi and Firefox: as far back as Kessel keeps history; no frames, reloads or redirect steps |
| 52.03 | Import passwords | 🟢 | |
| 52.04 | Import cookies where supported | 🟢 | |
| 52.05 | Import settings | ✅ | Settings -> About -> Restore (a Kessel settings file) |
| 52.06 | Import open tabs | ✅ | Each window's tabs as a saved tab group on the bookmarks bar (Chromium session files, Firefox's session) |
| 52.07 | Import extensions | 🟡 | Chrome Web Store and Edge Add-ons extensions from Chromium browsers, each added after you see what it can do; Firefox add-ons don't run in Kessel |
| 52.08 | Import from Chrome | 🟢 | |
| 52.09 | Import from Edge | ✅ | Each Edge profile: bookmarks with their folders, history, open tabs, cookies, passwords, extensions |
| 52.10 | Import from Firefox | ✅ | Bookmarks (folders and tags), pinned New Tab sites, history, open tabs, cookies, passwords (without a Primary Password; with one, Firefox's CSV export) |
| 52.11 | Import from Safari | 🟡 | Its bookmarks, from Safari's HTML export; Safari doesn't run on Windows |
| 52.12 | Import HTML bookmarks | ✅ | |
| 52.13 | Export bookmarks | ✅ | |
| 52.14 | Export passwords | ✅ | See 7.09 |
| 52.15 | Export history | ✅ | Settings -> History -> Export: a CSV file |
| 52.16 | Export settings | ✅ | Settings -> About -> Save to a file |
| 52.17 | Export sessions | ✅ | Settings -> Tabs -> Save open tabs: a bookmarks file, a folder per window |

### 53. Updates

| # | Feature | Status | Notes |
|---|---|---|---|
| 53.01 | Automatic browser updates | ⏭️ | Needs an update server and a code-signing certificate (your choice of provider): left out |
| 53.02 | Background updates | ⏭️ | Needs an update server and a code-signing certificate (your choice of provider): left out |
| 53.03 | Update notifications | ⏭️ | Needs an update server and a code-signing certificate (your choice of provider): left out |
| 53.04 | Update channels (stable, beta, developer, canary) | ⏭️ | Needs an update server and a code-signing certificate (your choice of provider): left out |
| 53.05 | Extension updates | 🟢 | Store extensions update by themselves, keeping their data (tested) |
| 53.06 | Component updates | ⏭️ | Needs an update server and a code-signing certificate (your choice of provider): left out |
| 53.07 | Security updates | ⏭️ | Needs an update server and a code-signing certificate (your choice of provider): left out |
| 53.08 | Rollback/recovery | ⏭️ | Needs an update server and a code-signing certificate (your choice of provider): left out |
| 53.09 | Update verification | ⏭️ | Needs an update server and a code-signing certificate (your choice of provider): left out |

### 54. Crash handling

| # | Feature | Status | Notes |
|---|---|---|---|
| 54.01 | Crash detection | ✅ | Every tab watches its processes (crash.rs): crashed, ended, out of memory, not responding, the graphics process, helpers, the engine itself |
| 54.02 | Automatic recovery | ✅ | A crashed tab in the background sleeps and loads again when you come back; Kessel's own pages reload; the engine going restarts Kessel with your tabs |
| 54.03 | Session restoration | ✅ | After the engine crashes, Kessel starts again with your tabs; after Kessel closed unexpectedly, a chip offers them back (when it doesn't restore them anyway) |
| 54.04 | Crash reports | ✅ | crashes.json, in kessel://diagnostics: what stopped, on which page, why, the exit code and the module the engine blames; Kessel's own panics too |
| 54.05 | Error pages | ✅ | A crashed page, or one that can't be reached, shows Kessel's page with Reload / Try again, and why |
| 54.06 | Safe mode | ✅ | kessel.exe --safe-mode, the palette's Restart in safe mode, or by itself after two starts in a row that never finished: no extensions, no graphics card, no engine switches; a chip says so and restarts normally |
| 54.07 | Extension-disable recovery | ✅ | Safe mode runs no extension (they stay installed and on); after Kessel failed to start twice it starts that way by itself |
| 54.08 | GPU crash recovery | ✅ | The engine starts a new graphics process by itself; after three crashes in ten minutes Kessel offers to stop using the graphics card (and restart) |
| 54.09 | Corrupted-profile recovery | ✅ | Kessel's files (settings, session, accounts, passwords...) are written whole, keeping the last as a backup; a damaged one is set aside and its backup used |

### 55. Browser settings

| # | Feature | Status | Notes |
|---|---|---|---|
| 55.01 | General: startup, homepage, new tab | 🟡 | Homepage + restore tabs |
| 55.02 | General: default browser | ⏳ | |
| 55.03 | General: downloads | 🟢 | Settings -> Downloads: the folder, ask where to save each file |
| 55.04 | General: appearance | 🟢 | |
| 55.05 | General: language | ⏳ | |
| 55.06 | Search: default engine, suggestions, shortcuts, private search | 🟡 | Default engine only |
| 55.07 | Privacy: cookies, tracking, fingerprinting, history, cache, site data, DNS, Do Not Track | 🟡 | Tracking + fingerprinting |
| 55.08 | Security: safe browsing, HTTPS-only, certificates, passwords, passkeys, security keys | 🟡 | HTTPS upgrade + passwords |
| 55.09 | Permissions: location, camera, microphone, notifications, pop-ups, autoplay, downloads, clipboard, sensors, USB, Bluetooth | ✅ | Settings -> Site permissions: location, camera, microphone, notifications, pop-ups, sound, downloads, clipboard, sensors, MIDI, fonts, files -- per site and for every site; USB and Bluetooth: WebView2 has no device chooser |
| 55.10 | Performance: hardware acceleration, memory saver, energy saver, tab sleeping, preloading | 🟡 | Tab sleeping |
| 55.11 | Sync: accounts, devices, data types, encryption, status | ⏭️ | Needs an online account or server: left out |
| 55.12 | Profiles: create, delete, switch, customize, default | 🟡 | Accounts popup |
| 55.13 | Extensions: installed, permissions, developer mode, store | 🟢 | Settings -> Extensions: installed ones, their site access, developer mode (load unpacked), the stores |
| 55.14 | Accessibility: zoom, fonts, reader mode, screen reader, reduced motion | ✅ | Settings -> Accessibility (section 22); zoom in Appearance; reader mode with F9 |

### 56. Account system

| # | Feature | Status | Notes |
|---|---|---|---|
| 56.01 | Account login | ⏭️ | Needs an online account or server: left out |
| 56.02 | Account creation | ⏭️ | Needs an online account or server: left out |
| 56.03 | Email verification | ⏭️ | Needs an online account or server: left out |
| 56.04 | MFA | ⏭️ | Needs an online account or server: left out |
| 56.05 | Passkeys | ⏭️ | Needs an online account or server: left out |
| 56.06 | Device management | ⏭️ | Needs an online account or server: left out |
| 56.07 | Session management | ⏭️ | Needs an online account or server: left out |
| 56.08 | Sync | ⏭️ | Needs an online account or server: left out |
| 56.09 | Cloud backup | ⏭️ | Needs an online account or server: left out |
| 56.10 | Encrypted browser data | ⏳ | |
| 56.11 | Remote logout | ⏭️ | Needs an online account or server: left out |
| 56.12 | Device removal | ⏭️ | Needs an online account or server: left out |
| 56.13 | Account recovery | ⏭️ | Needs an online account or server: left out |
| 56.14 | Privacy dashboard | ✅ | kessel://privacy (command palette -> Privacy dashboard, or Settings -> Privacy): what Shields blocked and cleaned day by day and per site, your protections, what sites may use, how your passwords are |

### 57. Browser lock

| # | Feature | Status | Notes |
|---|---|---|---|
| 57.01 | PIN lock | ✅ | Settings -> Security -> Lock Kessel: a PIN (4 to 12 digits). Locked, every window shows the lock screen; the pages are hidden from the engine (no keys reach them) and shortcuts do nothing; five wrong tries, then a wait |
| 57.02 | Password lock | ✅ | As 57.01, with a password instead (Argon2id, like the password vault) |
| 57.03 | Windows Hello | 🧪 | Settings -> Security -> Also unlock with Windows Hello: the lock screen's Use Windows Hello (face, fingerprint or Windows PIN); built, but trying it takes a person at the PC |
| 57.04 | Fingerprint | 🧪 | Through Windows Hello (57.03) |
| 57.05 | Face unlock | 🧪 | Through Windows Hello (57.03) |
| 57.06 | Lock private tabs | ✅ | Settings -> Security -> What it locks: Private windows only |
| 57.07 | Lock profiles | ✅ | Each profile (kessel.exe --profile) has its own lock |
| 57.08 | Lock password manager | 🟢 | Vault auto-lock |
| 57.09 | Lock browser on startup | ✅ | Settings -> Security: Lock when Kessel starts |
| 57.10 | Automatic lock after inactivity | ✅ | Settings -> Security: Lock when the PC is left alone for 1 minute to 1 hour |

### 58. Search / history intelligence

| # | Feature | Status | Notes |
|---|---|---|---|
| 58.01 | Semantic history search | ⏳ | |
| 58.02 | Search by title | ✅ | History: search by title (tested) |
| 58.03 | Search by URL | ✅ | History: search by a piece of the address (tested) |
| 58.04 | Search by text content | ✅ | Settings -> History -> Remember what pages say (off by default): History finds a page by any words on it, with them shown around; kept on this computer, gone with the page's history, never from private windows |
| 58.05 | Search by date | ✅ | History: today, yesterday, the last 7 or 30 days, or a day you pick (tested) |
| 58.06 | Search by domain | ✅ | History: by site (tested) |
| 58.07 | Search by tab | 🟢 | Tab search (Ctrl+Shift+A): open, sleeping and closed tabs (tested) |
| 58.08 | Search by workspace | ⏳ | |
| 58.09 | Search by profile | ⏳ | |
| 58.10 | Search screenshots | ⏳ | |
| 58.11 | Search downloaded files | 🟢 | Downloads page: search and sort (tested) |
| 58.12 | Search bookmarks | 🟢 | Bookmark manager: search, #tag for a tag (tested) |
| 58.13 | Search reading list | 🟢 | Side panel -> Search: open tabs, bookmarks, the reading list, notes and history |

### 59. Offline functionality

| # | Feature | Status | Notes |
|---|---|---|---|
| 59.01 | Offline page cache | ✅ | As 17.04: the reading list keeps whole copies of pages |
| 59.02 | Offline reading | ✅ | Offline, the reading list opens its saved copy; the can't-be-reached page offers it (tested) |
| 59.03 | Offline PWAs | 🟡 | Sites with a service worker work offline (37.09); installing them as apps is still to do (31.01) |
| 59.04 | Service workers | 🌐 | Service workers answer their pages' requests (tested, 60.04) |
| 59.05 | Background synchronization | 🌐 | A site's service worker gets its background sync once it's online (tested) |
| 59.06 | Cached resources | 🌐 | The engine's HTTP cache and service-worker caches |
| 59.07 | Offline error page | ✅ | A site that can't be reached gets Kessel's page: why, Try again, the saved copy if there's one (tested) |
| 59.08 | Offline downloads | ⏳ | |
| 59.09 | Network recovery | ✅ | Back online, the can't-be-reached page loads the site by itself (tested) |
| 59.10 | Automatic retry | ✅ | A site that's down is tried again every 30 seconds while its page is open |

### 60. Web standards compatibility

| # | Feature | Status | Notes |
|---|---|---|---|
| 60.01 | HTML, CSS, JavaScript, WebAssembly | 🌐 | WebView2's: today's HTML, CSS and JavaScript, WebAssembly (tested in a page) |
| 60.02 | WebGL, WebGPU | 🌐 | WebGL 2 and WebGPU (tested; kessel://gpu shows the adapters) |
| 60.03 | WebRTC, WebSockets, Fetch, Streams | 🌐 | WebRTC, WebSockets, fetch with streams (tested) |
| 60.04 | Web Workers, Service Workers, IndexedDB | 🌐 | Web workers, service workers (one answering its scope's requests), IndexedDB (tested) |
| 60.05 | Web Crypto, WebAuthn | 🌐 | Web Crypto; WebAuthn with Windows Hello as the platform authenticator (tested: it's there) |
| 60.06 | Notifications, Push API | 🟡 | Notifications: Kessel asks (tested); the Push API is there but WebView2 has no push service -- a subscription never gets an answer |
| 60.07 | Payment Request | ⏭️ | WebView2 has no Payment Request |
| 60.08 | Clipboard API, File System Access, Web Share | 🌐 | Clipboard API (writing; reading asks), File System Access (pickers, the private file system), Web Share (Windows' Share window) (tested) |
| 60.09 | Fullscreen API, Wake Lock | 🌐 | Fullscreen API, Wake Lock (tested) |
| 60.10 | Web Bluetooth, WebUSB, WebHID, Web Serial, MIDI | 🟡 | MIDI: Kessel asks (tested); Bluetooth, USB, HID and Serial are in the engine but WebView2 has no device chooser |
| 60.11 | Sensors, Geolocation | 🟡 | Geolocation: Kessel asks (tested); sensors untried (no sensors on this PC) |
| 60.12 | Media APIs, Accessibility APIs | 🌐 | Media Source, MediaRecorder, Web Audio, WebCodecs; the accessibility tree (tested) |

### 61. Developer-facing browser architecture

| # | Feature | Status | Notes |
|---|---|---|---|
| 61.01 | Browser, renderer, GPU, network and storage processes | 🌐 | WebView2's processes; kessel://tasks lists them by job |
| 61.02 | JavaScript engine, JIT, WebAssembly engine | 🌐 | V8, WebView2's |
| 61.03 | Rendering engine: HTML/CSS parsers, DOM, layout, paint, compositor, GPU backend | 🌐 | Blink, WebView2's |
| 61.04 | Networking stack, DNS resolver, certificate verifier, HTTP cache, cookie store | 🌐 | Chromium's network stack, DNS and certificate checks, cache and cookies; Kessel adds its cookie rules, Shields and HTTPS-only |
| 61.05 | Permission manager | 🟢 | permissions.rs: Kessel's own prompt and per-site answers over the engine's |
| 61.06 | Extension system | 🟢 | extensions.rs over the engine's extension support |
| 61.07 | Profile manager | 🟢 | Accounts |
| 61.08 | Sync engine | ⏭️ | Needs an online account or server: left out |
| 61.09 | Password manager | 🟢 | |
| 61.10 | Download manager | 🟡 | |
| 61.11 | History database | 🟢 | |
| 61.12 | Bookmark database | 🟢 | |
| 61.13 | DevTools | 🌐 | F12: the engine's DevTools (section 29) |
| 61.14 | Crash reporter | ✅ | crash.rs: crashes.json and kessel://diagnostics; nothing is sent anywhere |
| 61.15 | Update system | ⏭️ | Needs an update server and a code-signing certificate (your choice of provider): left out (as 53.01) |
| 61.16 | Sandbox, site-isolation system, IPC system | 🌐 | Chromium's sandbox, site isolation and IPC |
| 61.17 | Accessibility layer | 🌐 | UI Automation, through WebView2; see section 22 |

### 62. "Crazy advanced" features

| # | Feature | Status | Notes |
|---|---|---|---|
| 62.01 | AI-native command bar | ⏭️ | Needs an AI service account (the side panel's AI assistant is the account-free part): left out |
| 62.02 | AI semantic history | ⏭️ | Needs an AI service account (the side panel's AI assistant is the account-free part): left out |
| 62.03 | AI tab organization | ⏭️ | Needs an AI service account (the side panel's AI assistant is the account-free part): left out |
| 62.04 | AI workspace creation | ⏭️ | Needs an AI service account (the side panel's AI assistant is the account-free part): left out |
| 62.05 | Automatic session recovery | ✅ | As 26.03 |
| 62.06 | Automatic tab cleanup | 🟢 | Idle tab discarding |
| 62.07 | Automatic duplicate-tab detection | ✅ | Command palette -> Close duplicate tabs |
| 62.08 | Tab memory visualization | ✅ | The task manager: memory and CPU of each page's process, with its tabs; hover cards |
| 62.09 | Tab dependency detection | ⏳ | |
| 62.10 | Website change monitoring | ✅ | Command palette -> Watch this page for changes: checked every 15 minutes to once a day (kessel://feeds), its text compared with last time |
| 62.11 | Page-change notifications | ✅ | When a watched page's text changed the toolbar says so, with what's new; opening it from there or the feeds page marks it seen |
| 62.12 | Built-in notes | 🟢 | Side panel -> Notes (tested) |
| 62.13 | Notes attached to URLs | 🟢 | A note keeps the page it was written on (right-click -> Save selection to notes) |
| 62.14 | Web annotations | 🧪 | Highlights with notes on any web page (Ctrl+Shift+H) |
| 62.15 | Collaborative tabs | ⏭️ | Needs an online account or server: left out |
| 62.16 | Collaborative workspaces | ⏭️ | Needs an online account or server: left out |
| 62.17 | Shared sessions | ⏭️ | Needs an online account or server: left out |
| 62.18 | Cloud browser profiles | ⏭️ | Needs an online account or server: left out |
| 62.19 | Encrypted browser backup | ⏳ | |
| 62.20 | Temporary browser identities | ⏳ | |
| 62.21 | Website-specific containers | 🟡 | Accounts per tab |
| 62.22 | Per-site browser personalities | ⏳ | |
| 62.23 | Built-in automation | ⏳ | |
| 62.24 | Browser macros | ⏳ | |
| 62.25 | Workflow automation | ⏳ | |
| 62.26 | Command palette | ✅ | F2: every command, searchable, recent ones first |
| 62.27 | Keyboard-first UI | 🟢 | The command palette (F2), every shortcut yours to change, links opened from the keyboard, F6 / Shift+F6 |
| 62.28 | Power-user settings | 🟢 | Engine switches, command chains, mouse gestures, your own shortcuts, your own CSS per site |
| 62.29 | Browser telemetry dashboard | ✅ | Kessel sends no telemetry; the privacy dashboard lists every connection it makes by itself -- filter lists, dangerous-site lists, suggestions, answers, extension updates, feeds -- and whether each is on |
| 62.30 | Privacy dashboard | ✅ | The privacy dashboard (56.14) |
| 62.31 | Permission dashboard | 🟢 | Settings -> Site permissions: every site's answers in one place |
| 62.32 | Site resource dashboard | 🟡 | The task manager: memory and CPU of each page's process |

### 63. Researched additions (2026)

Features other browsers ship today that the list above doesn't name.
Only ones that work on this PC, without an account or a server.

| # | Feature | Status | Notes |
|---|---|---|---|
| 63.01 | Site boosts: your own CSS for a site (Zen Boosts, Arc Boosts) | ✅ | Command palette -> Change this site: your own CSS |
| 63.02 | Page filters: grayscale, invert, sepia, dark, contrast per site (Vivaldi page actions) | ✅ | Per site, or one for every site (Settings -> Page tools) |
| 63.03 | Element zapper: hide a page element for good (uBlock, Safari distraction control) | ✅ | Command palette -> Hide an element; undo in Settings -> Page tools |
| 63.04 | Link preview in a floating window (Zen Glance, Arc Peek) | ✅ | Right-click a link -> Peek at link (a pop-out window; Back to tabs keeps it) |
| 63.05 | Compact mode: toolbars hide until the mouse comes near (Zen) | ⏳ | |
| 63.06 | Feed reader: detect RSS/Atom feeds, follow them locally (Vivaldi) | ✅ | kessel://feeds: RSS, Atom, JSON Feed; follow from the palette; OPML import/export |
| 63.07 | Break mode: pause every page and all sound at once (Vivaldi) | ✅ | Command palette -> Pause everything |
| 63.08 | Auto-archive tabs you haven't touched in days (Arc) | ✅ | Settings -> Tabs -> Close tabs you've forgotten (counted while Kessel is open) |
| 63.09 | De-AMP: open a page's real address instead of its AMP copy (Brave) | ✅ | On by default; Settings -> Page tools |
| 63.10 | Wayback Machine offer on dead pages (Brave) | ✅ | A missing page (404/410) offers its saved copy; the palette opens any page there |
| 63.11 | Forget a site's data when its last tab closes (Brave forgetful browsing) | ✅ | Settings -> Privacy -> Forget these sites when you close them |
| 63.12 | Copy clean link: without tracking parameters (Firefox) | 🧪 | Command palette -> Copy link without tracking |
| 63.13 | Auto-reload a tab every N seconds (Vivaldi, Opera) | ✅ | Command palette -> Auto-reload this site; your own intervals |
| 63.14 | Mute background tabs automatically (Vivaldi) | ✅ | Settings -> Tabs -> Only the tab you're on plays sound |
| 63.15 | Status bar with the link under the mouse and a clock (Vivaldi) | 🟡 | The engine already shows the link under the mouse; no clock yet |
| 63.16 | Link hints: open links from the keyboard (Vimium, Vivaldi) | ✅ | Command palette -> Open a link with the keyboard |
| 63.17 | Paste and go / paste and search (Chrome, Firefox) | 🧪 | Command palette -> Paste and go |
| 63.18 | Tab folders / stacks in the tab strip (Zen, Vivaldi) | ⏳ | |
| 63.19 | Command chains: several commands under one shortcut (Vivaldi) | ✅ | Settings -> Page tools -> Command chains; from the palette or a gesture |
| 63.20 | Search engines offered by sites (OpenSearch), added in a click (Chrome) | 🧪 | Sites' own search engines are offered in Settings -> Search & Startup |

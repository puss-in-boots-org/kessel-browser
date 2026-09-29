# Kessel feature checklist

Every keyboard shortcut and every item of the "Complete Modern Browser Feature
List", with what Kessel does about it. Work happens on the `feature-list`
branch, one small commit per feature or group of features.

## Status legend

| Mark | Meaning |
|---|---|
| ✅ | Built on this branch and tested |
| 🟢 | Already in Kessel before this branch (checked) |
| 🌐 | Provided by the engine (WebView2 / Chromium) itself; verified it works in Kessel |
| 🧪 | Built, with unit tests and an end-to-end test written; waiting for that test's first run on Windows |
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

**43% overall** -- 386 done (✅ 🟢 🌐), 31 built and waiting for their Windows test run (🧪), 53 partly done (🟡), 551 to do (⏳), 4 skipped (⏭️), of 1025.

| Section | Done | 🧪 | 🟡 | ⏳ | ⏭️ | Progress |
|---|---:|---:|---:|---:|---:|---|
| [Keyboard shortcuts (the requested table)](#keyboard-shortcuts-the-requested-table) | 52 |  |  |  |  | `██████████` 100% |
| [1. Core browsing -- navigation](#1-core-browsing----navigation) | 22 |  |  |  |  | `██████████` 100% |
| [2. Tabs](#2-tabs) | 46 |  |  |  | 1 | `██████████` 100% |
| [3. Windows](#3-windows) | 5 |  | 4 | 6 |  | `█████░░░░░` 47% |
| [4. Bookmarks](#4-bookmarks) | 4 |  | 2 | 13 |  | `███░░░░░░░` 26% |
| [5. History](#5-history) | 14 |  |  | 2 |  | `█████████░` 88% |
| [6. Downloads](#6-downloads) | 5 |  | 1 | 16 |  | `███░░░░░░░` 25% |
| [7. Passwords & identity](#7-passwords--identity) | 7 |  | 4 | 26 |  | `██░░░░░░░░` 24% |
| [8. Profiles](#8-profiles) | 6 |  | 6 | 4 |  | `██████░░░░` 56% |
| [9. Sync](#9-sync) |  |  |  | 18 |  | `░░░░░░░░░░` 0% |
| [10. Privacy](#10-privacy) | 38 |  |  |  | 1 | `██████████` 100% |
| [11. Security](#11-security) | 24 |  |  |  |  | `██████████` 100% |
| [12. DNS & networking](#12-dns--networking) | 9 |  |  | 14 |  | `████░░░░░░` 39% |
| [13. Website permissions](#13-website-permissions) |  |  |  | 20 |  | `░░░░░░░░░░` 0% |
| [14. Site-specific settings](#14-site-specific-settings) |  |  |  | 22 |  | `░░░░░░░░░░` 0% |
| [15. Extensions / add-ons](#15-extensions--add-ons) | 9 |  | 7 |  | 1 | `████████░░` 78% |
| [16. Built-in content blocking](#16-built-in-content-blocking) | 12 |  | 1 | 3 |  | `████████░░` 78% |
| [17. Reading & research](#17-reading--research) | 5 |  | 1 | 16 |  | `███░░░░░░░` 25% |
| [18. Translation](#18-translation) |  |  |  | 10 |  | `░░░░░░░░░░` 0% |
| [19. PDF](#19-pdf) |  |  |  | 18 |  | `░░░░░░░░░░` 0% |
| [20. Media](#20-media) | 1 | 18 | 1 |  |  | `██████████` 98% |
| [21. Picture-in-picture](#21-picture-in-picture) |  |  |  | 8 |  | `░░░░░░░░░░` 0% |
| [22. Accessibility](#22-accessibility) | 3 | 1 | 1 | 11 |  | `███░░░░░░░` 28% |
| [23. Appearance](#23-appearance) | 11 |  |  | 5 |  | `███████░░░` 69% |
| [24. Search engines](#24-search-engines) | 2 |  |  | 7 |  | `██░░░░░░░░` 22% |
| [25. Startup behavior](#25-startup-behavior) | 4 |  | 1 | 4 |  | `█████░░░░░` 50% |
| [26. Session management](#26-session-management) | 1 |  | 5 | 5 |  | `███░░░░░░░` 32% |
| [27. Browser workspaces](#27-browser-workspaces) | 5 |  | 1 |  | 1 | `█████████░` 92% |
| [28. Sidebar](#28-sidebar) | 11 |  |  |  |  | `██████████` 100% |
| [29. Developer tools](#29-developer-tools) | 11 |  |  |  |  | `██████████` 100% |
| [30. Web platform support](#30-web-platform-support) |  |  |  | 6 |  | `░░░░░░░░░░` 0% |
| [31. Progressive Web Apps](#31-progressive-web-apps) |  |  |  | 15 |  | `░░░░░░░░░░` 0% |
| [32. Notifications](#32-notifications) |  |  |  | 10 |  | `░░░░░░░░░░` 0% |
| [33. Clipboard](#33-clipboard) |  |  |  | 7 |  | `░░░░░░░░░░` 0% |
| [34. File system](#34-file-system) |  |  |  | 10 |  | `░░░░░░░░░░` 0% |
| [35. Hardware acceleration](#35-hardware-acceleration) |  | 8 | 1 |  |  | `█████████░` 94% |
| [36. Performance](#36-performance) | 11 | 1 |  | 5 |  | `███████░░░` 71% |
| [37. Cache](#37-cache) | 6 |  |  | 4 |  | `██████░░░░` 60% |
| [38. Developer / experimental controls](#38-developer--experimental-controls) |  |  |  | 13 |  | `░░░░░░░░░░` 0% |
| [39. Browser information & diagnostics](#39-browser-information--diagnostics) | 3 | 2 | 3 | 8 |  | `████░░░░░░` 41% |
| [40. Built-in task management](#40-built-in-task-management) |  |  |  | 9 |  | `░░░░░░░░░░` 0% |
| [41. Screenshots & capture](#41-screenshots--capture) |  |  |  | 11 |  | `░░░░░░░░░░` 0% |
| [42. Sharing](#42-sharing) |  |  |  | 9 |  | `░░░░░░░░░░` 0% |
| [43. Mobile-specific features](#43-mobile-specific-features) |  |  |  | 15 |  | `░░░░░░░░░░` 0% |
| [44. Desktop-specific features](#44-desktop-specific-features) | 6 | 1 | 1 | 5 |  | `██████░░░░` 58% |
| [45. Keyboard shortcuts](#45-keyboard-shortcuts) | 25 |  |  | 3 |  | `█████████░` 89% |
| [46. Mouse / trackpad](#46-mouse--trackpad) | 6 |  |  | 6 |  | `█████░░░░░` 50% |
| [47. Context menus](#47-context-menus) | 2 |  |  | 8 |  | `██░░░░░░░░` 20% |
| [48. AI features](#48-ai-features) | 2 |  | 2 | 16 |  | `██░░░░░░░░` 15% |
| [49. Shopping](#49-shopping) |  |  |  | 10 |  | `░░░░░░░░░░` 0% |
| [50. Media & entertainment extras](#50-media--entertainment-extras) |  |  |  | 11 |  | `░░░░░░░░░░` 0% |
| [51. Privacy-focused advanced features](#51-privacy-focused-advanced-features) | 6 |  |  | 8 |  | `████░░░░░░` 43% |
| [52. Import / export](#52-import--export) | 4 |  |  | 13 |  | `██░░░░░░░░` 24% |
| [53. Updates](#53-updates) |  |  |  | 9 |  | `░░░░░░░░░░` 0% |
| [54. Crash handling](#54-crash-handling) |  |  | 3 | 6 |  | `██░░░░░░░░` 17% |
| [55. Browser settings](#55-browser-settings) | 1 |  | 6 | 7 |  | `███░░░░░░░` 29% |
| [56. Account system](#56-account-system) |  |  |  | 14 |  | `░░░░░░░░░░` 0% |
| [57. Browser lock](#57-browser-lock) | 1 |  |  | 9 |  | `█░░░░░░░░░` 10% |
| [58. Search / history intelligence](#58-search--history-intelligence) |  |  |  | 13 |  | `░░░░░░░░░░` 0% |
| [59. Offline functionality](#59-offline-functionality) |  |  |  | 10 |  | `░░░░░░░░░░` 0% |
| [60. Web standards compatibility](#60-web-standards-compatibility) |  |  |  | 12 |  | `░░░░░░░░░░` 0% |
| [61. Developer-facing browser architecture](#61-developer-facing-browser-architecture) | 5 |  | 1 | 11 |  | `███░░░░░░░` 32% |
| [62. "Crazy advanced" features](#62-crazy-advanced-features) | 1 |  | 1 | 30 |  | `░░░░░░░░░░` 5% |

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
| 3.04 | Separate profile windows | 🟡 | Account pop-out windows |
| 3.05 | Always-on-top window mode | 🟡 | Pop-out windows only |
| 3.06 | Picture-in-picture windows | ⏳ | |
| 3.07 | Pop-out video windows | ⏳ | |
| 3.08 | Restore previous windows | ✅ | Session restore reopens every window with its own tabs |
| 3.09 | Restore individual windows | 🟡 | A closed window reopens with its tabs (reopen_closed_window) |
| 3.10 | Window session saving | ✅ | Each window's tabs are saved as they change |
| 3.11 | Window organization | ⏳ | |
| 3.12 | Window naming | ⏳ | |
| 3.13 | Split-screen browser windows | ⏳ | |
| 3.14 | Side-by-side page viewing | 🟡 | The side panel shows a second page beside the tab |
| 3.15 | Window-specific tab groups | ⏳ | |

### 4. Bookmarks

| # | Feature | Status | Notes |
|---|---|---|---|
| 4.01 | Bookmark page | 🟢 | |
| 4.02 | Bookmark folders | ⏳ | |
| 4.03 | Nested folders | ⏳ | |
| 4.04 | Bookmark bar | 🟢 | |
| 4.05 | Bookmark manager | ⏳ | |
| 4.06 | Bookmark search | ⏳ | |
| 4.07 | Bookmark editing | ⏳ | |
| 4.08 | Bookmark deletion | 🟢 | |
| 4.09 | Bookmark sorting | ⏳ | |
| 4.10 | Bookmark import | 🟡 | From Opera GX, Opera, Brave and Chrome |
| 4.11 | Bookmark export | ⏳ | |
| 4.12 | Bookmark synchronization | ⏳ | |
| 4.13 | Bookmark tags | ⏳ | |
| 4.14 | Bookmark descriptions | ⏳ | |
| 4.15 | Favicons | 🟢 | |
| 4.16 | Bookmark previews | ⏳ | |
| 4.17 | Bookmark duplicate detection | 🟡 | The same address is never saved twice |
| 4.18 | Bookmark organization tools | ⏳ | |
| 4.19 | Bookmark backup | ⏳ | |

### 5. History

| # | Feature | Status | Notes |
|---|---|---|---|
| 5.01 | Browsing history | ✅ | Now a database (SQLite) instead of the last 500 visits; kept 90 days by default |
| 5.02 | History search | ✅ | Every word must appear in the title or address |
| 5.03 | History by date | ✅ | Grouped by day; Today, Yesterday, last 7 / 30 days, or any single day |
| 5.04 | History by website | ✅ | History -> By site: visits per site; show or delete a whole site |
| 5.05 | History by tab/window | ⏳ | |
| 5.06 | Delete individual entries | ✅ | A page's menu, or tick several and Delete |
| 5.07 | Delete time ranges | ✅ | Clear browsing data (last hour ... all time); or a day's pages in History |
| 5.08 | Clear all browsing history | ✅ | Clear browsing data -> All time |
| 5.09 | Recently closed pages | 🟢 | |
| 5.10 | Recently closed tabs | 🟢 | |
| 5.11 | Recently closed windows | ✅ | See 2.29 |
| 5.12 | Search history | ✅ | History -> Searches: what you searched on Google, Bing, DuckDuckGo, YouTube, Wikipedia, Amazon and more |
| 5.13 | Download history | 🟢 | |
| 5.14 | History synchronization | ⏳ | |
| 5.15 | History suggestions | ✅ | In the address bar, as you type |
| 5.16 | Address-bar history integration | ✅ | See 1.11 |

### 6. Downloads

| # | Feature | Status | Notes |
|---|---|---|---|
| 6.01 | Download manager | 🟡 | Basic list |
| 6.02 | Download list | 🟢 | |
| 6.03 | Download progress | ⏳ | |
| 6.04 | Pause downloads | ⏳ | |
| 6.05 | Resume downloads | ⏳ | |
| 6.06 | Cancel downloads | ⏳ | |
| 6.07 | Retry failed downloads | ⏳ | |
| 6.08 | Open downloaded file | 🟢 | |
| 6.09 | Show downloaded file in folder | ⏳ | |
| 6.10 | Change download location | ⏳ | |
| 6.11 | Ask where to save every file | ⏳ | |
| 6.12 | Automatic downloads | ⏳ | |
| 6.13 | Multiple simultaneous downloads | 🟢 | |
| 6.14 | Download notifications | 🟢 | Toasts |
| 6.15 | Dangerous-download detection | ⏳ | |
| 6.16 | File-type warnings | ⏳ | |
| 6.17 | Download scanning | ⏳ | |
| 6.18 | Download history | 🟢 | |
| 6.19 | Download sorting | ⏳ | |
| 6.20 | Download search | ⏳ | |
| 6.21 | Automatic download organization | ⏳ | |
| 6.22 | Per-site download permissions | ⏳ | |

### 7. Passwords & identity

| # | Feature | Status | Notes |
|---|---|---|---|
| 7.01 | Password manager | 🟢 | Encrypted vault (AES-256-GCM, Argon2id, optional TOTP) |
| 7.02 | Save passwords | ⏳ | |
| 7.03 | Autofill passwords | 🟡 | Chip only worked on Kessel's own pages |
| 7.04 | Generate strong passwords | 🟢 | |
| 7.05 | Password editing | 🟢 | |
| 7.06 | Password deletion | 🟢 | |
| 7.07 | Password search | 🟢 | The Passwords page's search box |
| 7.08 | Password import | 🟢 | Browsers and CSV |
| 7.09 | Password export | ⏳ | |
| 7.10 | Password synchronization | ⏳ | |
| 7.11 | Password security checks | ⏳ | |
| 7.12 | Weak-password detection | ⏳ | |
| 7.13 | Reused-password detection | ⏳ | |
| 7.14 | Compromised-password detection | ⏳ | |
| 7.15 | Password notes | 🟢 | |
| 7.16 | Password organization | ⏳ | |
| 7.17 | Passkeys | ⏳ | |
| 7.18 | Passkey creation | ⏳ | |
| 7.19 | Passkey login | ⏳ | |
| 7.20 | Passkey storage | ⏳ | |
| 7.21 | Passkey synchronization | ⏳ | |
| 7.22 | Hardware-security-key authentication | ⏳ | |
| 7.23 | Biometric authentication | ⏳ | |
| 7.24 | WebAuthn | ⏳ | |
| 7.25 | FIDO2 | ⏳ | |
| 7.26 | Security-key support | ⏳ | |
| 7.27 | Username autofill | 🟡 | With the password chip |
| 7.28 | Password autofill | 🟡 | See 7.03 |
| 7.29 | Name autofill | ⏳ | |
| 7.30 | Address autofill | ⏳ | |
| 7.31 | Phone-number autofill | ⏳ | |
| 7.32 | Email autofill | ⏳ | |
| 7.33 | Payment autofill | ⏳ | |
| 7.34 | Credit/debit card storage | ⏳ | |
| 7.35 | Expiration-date autofill | ⏳ | |
| 7.36 | Form-data autofill | ⏳ | |
| 7.37 | One-click autofill | 🟡 | See 7.03 |

### 8. Profiles

| # | Feature | Status | Notes |
|---|---|---|---|
| 8.01 | Multiple browser profiles | 🟡 | Accounts: separate sign-ins in one window |
| 8.02 | Separate profile history | 🟡 | kessel.exe --profile <name> runs a fully separate profile (own history, bookmarks, passwords, settings, cookies); switching UI to come |
| 8.03 | Separate bookmarks | 🟡 | See 8.02 |
| 8.04 | Separate passwords | 🟡 | See 8.02 |
| 8.05 | Separate extensions | 🟡 | See 8.02 |
| 8.06 | Separate cookies | 🟢 | Accounts |
| 8.07 | Separate browsing sessions | 🟢 | Accounts |
| 8.08 | Profile avatars | 🟢 | Accounts |
| 8.09 | Profile names | 🟢 | Accounts |
| 8.10 | Profile colors/themes | 🟡 | Account colours |
| 8.11 | Profile switching | 🟢 | Accounts |
| 8.12 | Profile startup shortcuts | ⏳ | |
| 8.13 | Profile-specific settings | ⏳ | |
| 8.14 | Profile-specific search engines | ⏳ | |
| 8.15 | Profile-specific downloads | ⏳ | |
| 8.16 | Profile isolation | 🟢 | Separate WebView2 data folder per account |

### 9. Sync

| # | Feature | Status | Notes |
|---|---|---|---|
| 9.01 | Bookmark sync | ⏳ | |
| 9.02 | History sync | ⏳ | |
| 9.03 | Password sync | ⏳ | |
| 9.04 | Extension sync | ⏳ | |
| 9.05 | Settings sync | ⏳ | |
| 9.06 | Open-tab sync | ⏳ | |
| 9.07 | Tab-group sync | ⏳ | |
| 9.08 | Autofill sync | ⏳ | |
| 9.09 | Reading-list sync | ⏳ | |
| 9.10 | Theme sync | ⏳ | |
| 9.11 | Browser configuration sync | ⏳ | |
| 9.12 | Cross-platform synchronization | ⏳ | |
| 9.13 | Encrypted synchronization | ⏳ | |
| 9.14 | Selective synchronization | ⏳ | |
| 9.15 | Sync conflict handling | ⏳ | |
| 9.16 | Sync status | ⏳ | |
| 9.17 | Sync device list | ⏳ | |
| 9.18 | Remote device management | ⏳ | |

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
| 12.14 | Proxy support | ⏳ | |
| 12.15 | SOCKS proxy | ⏳ | |
| 12.16 | HTTP proxy | ⏳ | |
| 12.17 | PAC files | ⏳ | |
| 12.18 | System proxy | 🌐 | |
| 12.19 | Per-profile proxy | ⏳ | |
| 12.20 | Per-site proxy | ⏳ | |
| 12.21 | Connection diagnostics | ⏳ | |
| 12.22 | Network error reporting | ⏳ | |
| 12.23 | Offline detection | ⏳ | |

### 13. Website permissions

| # | Feature | Status | Notes |
|---|---|---|---|
| 13.01 | Camera permission | ⏳ | |
| 13.02 | Microphone permission | ⏳ | |
| 13.03 | Location permission | ⏳ | |
| 13.04 | Notifications permission | ⏳ | |
| 13.05 | Clipboard permission | ⏳ | |
| 13.06 | Fullscreen permission | ⏳ | |
| 13.07 | Motion sensor permission | ⏳ | |
| 13.08 | Bluetooth permission | ⏳ | |
| 13.09 | USB permission | ⏳ | |
| 13.10 | Serial-device permission | ⏳ | |
| 13.11 | HID-device permission | ⏳ | |
| 13.12 | MIDI permission | ⏳ | |
| 13.13 | Payment permission | ⏳ | |
| 13.14 | Autoplay permission | ⏳ | |
| 13.15 | Pop-up permission | ⏳ | |
| 13.16 | Downloads permission | ⏳ | |
| 13.17 | Background activity permission | ⏳ | |
| 13.18 | VR/AR permission | ⏳ | |
| 13.19 | Local-network permission | ⏳ | |
| 13.20 | File-system permission | ⏳ | |

### 14. Site-specific settings

| # | Feature | Status | Notes |
|---|---|---|---|
| 14.01 | JavaScript | ⏳ | |
| 14.02 | Cookies | ⏳ | |
| 14.03 | Pop-ups | ⏳ | |
| 14.04 | Redirects | ⏳ | |
| 14.05 | Camera | ⏳ | |
| 14.06 | Microphone | ⏳ | |
| 14.07 | Location | ⏳ | |
| 14.08 | Notifications | ⏳ | |
| 14.09 | Clipboard | ⏳ | |
| 14.10 | Downloads | ⏳ | |
| 14.11 | Autoplay | ⏳ | |
| 14.12 | MIDI | ⏳ | |
| 14.13 | Bluetooth | ⏳ | |
| 14.14 | USB | ⏳ | |
| 14.15 | Serial | ⏳ | |
| 14.16 | HID | ⏳ | |
| 14.17 | VR | ⏳ | |
| 14.18 | Fullscreen | ⏳ | |
| 14.19 | Images | ⏳ | |
| 14.20 | Sound | ⏳ | |
| 14.21 | Background sync | ⏳ | |
| 14.22 | Third-party content | ⏳ | |

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
| 16.10 | Autoplay blocker | ⏳ | |
| 16.11 | Script blocking | ⏳ | |
| 16.12 | Element blocking | 🟡 | Cosmetic filtering only ran on Kessel's own pages; element picker to do |
| 16.13 | Custom filter lists | ⏳ | |
| 16.14 | Allowlist | 🟢 | |
| 16.15 | Blocklist | 🟢 | |
| 16.16 | Per-site exceptions | 🟢 | |

### 17. Reading & research

| # | Feature | Status | Notes |
|---|---|---|---|
| 17.01 | Reader mode | ⏳ | |
| 17.02 | Reading list | ✅ | Side panel -> Reading list: unread/read, add the page you're on, or right-click a link: Add link to reading list |
| 17.03 | Save page for later | ✅ | Right-click a page: Add page to reading list |
| 17.04 | Offline pages | ⏳ | |
| 17.05 | Reading progress | ⏳ | |
| 17.06 | Page translation | ⏳ | |
| 17.07 | Dictionary | ⏳ | |
| 17.08 | Spell checker | ⏳ | |
| 17.09 | Grammar checking | ⏳ | |
| 17.10 | Text-to-speech | ⏳ | |
| 17.11 | Page narration | ⏳ | |
| 17.12 | Find in page | ✅ | Ctrl+F, the engine's own find bar |
| 17.13 | Find next/previous | ✅ | F3 / Ctrl+G, Shift+F3 / Ctrl+Shift+G |
| 17.14 | Search selected text | ⏳ | |
| 17.15 | Search image | ⏳ | |
| 17.16 | Copy selected text | ⏳ | |
| 17.17 | Highlight text | ⏳ | |
| 17.18 | Page annotations | ⏳ | |
| 17.19 | Web clipping | 🟡 | Pick text, right-click: Save selection to notes -- kept with the page it came from (text only) |
| 17.20 | Print | ✅ | Ctrl+P and the menu: the engine's print preview |
| 17.21 | Save as PDF | ⏳ | |
| 17.22 | Webpage screenshot | ⏳ | |

### 18. Translation

| # | Feature | Status | Notes |
|---|---|---|---|
| 18.01 | Automatic language detection | ⏳ | |
| 18.02 | Full-page translation | ⏳ | |
| 18.03 | Selected-text translation | ⏳ | |
| 18.04 | Translation popup | ⏳ | |
| 18.05 | Translation language preferences | ⏳ | |
| 18.06 | Automatic translation | ⏳ | |
| 18.07 | Never translate this language | ⏳ | |
| 18.08 | Never translate this site | ⏳ | |
| 18.09 | Offline translation | ⏳ | |
| 18.10 | Privacy-preserving translation | ⏳ | |

### 19. PDF

| # | Feature | Status | Notes |
|---|---|---|---|
| 19.01 | PDF viewer | ⏳ | |
| 19.02 | PDF search | ⏳ | |
| 19.03 | PDF zoom | ⏳ | |
| 19.04 | PDF page navigation | ⏳ | |
| 19.05 | PDF thumbnails | ⏳ | |
| 19.06 | PDF printing | ⏳ | |
| 19.07 | PDF download | ⏳ | |
| 19.08 | PDF save | ⏳ | |
| 19.09 | PDF rotation | ⏳ | |
| 19.10 | PDF text selection | ⏳ | |
| 19.11 | PDF copying | ⏳ | |
| 19.12 | PDF annotation | ⏳ | |
| 19.13 | PDF highlighting | ⏳ | |
| 19.14 | PDF drawing | ⏳ | |
| 19.15 | PDF form filling | ⏳ | |
| 19.16 | PDF signing | ⏳ | |
| 19.17 | PDF editing | ⏳ | |
| 19.18 | PDF presentation mode | ⏳ | |

### 20. Media

| # | Feature | Status | Notes |
|---|---|---|---|
| 20.01 | HTML5 video | 🧪 | The engine's player; Kessel's media controls work with every `<video>` |
| 20.02 | HTML5 audio | 🧪 | The engine's player; Kessel's media controls work with every `<audio>` |
| 20.03 | Media controls | 🧪 | The music-note button beside the menu (shown once a tab has played sound): every such tab of the window with title, artist, artwork, play/pause, ±10 s, a seek bar, previous/next, mute -- without switching tabs. Also a command ("media controls") |
| 20.04 | Fullscreen video | 🟢 | A video's (or any page's) fullscreen fills the whole screen |
| 20.05 | Picture-in-picture | 🧪 | Media controls -> picture-in-picture: the engine's floating video window |
| 20.06 | Multiple audio tracks | 🧪 | Switched on in the engine (AudioVideoTracks); media controls -> audio track, when a video has more than one |
| 20.07 | Subtitles | 🧪 | WebVTT subtitle tracks, drawn by the engine; media controls -> captions menu turns them on and off |
| 20.08 | Closed captions | 🧪 | Caption tracks, like subtitles (20.07) |
| 20.09 | Playback speed | 🧪 | Media controls -> speed: 0.5× to 3× (a site's own speed setting, 0.25× to 4×, is kept) |
| 20.10 | Media session controls | 🧪 | The page's Media Session: its title, artist and artwork show in the media controls, and its own previous/next/seek buttons are what they press |
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
| 21.01 | Video pop-out | ⏳ | |
| 21.02 | Always-on-top video | ⏳ | |
| 21.03 | Resize PiP window | ⏳ | |
| 21.04 | Move PiP window | ⏳ | |
| 21.05 | Pause/play | ⏳ | |
| 21.06 | Next/previous | ⏳ | |
| 21.07 | Subtitle support | ⏳ | |
| 21.08 | Multiple PiP windows where supported | ⏳ | |

### 22. Accessibility

| # | Feature | Status | Notes |
|---|---|---|---|
| 22.01 | Page zoom | ✅ | The engine's real zoom, remembered per site; Settings -> Appearance: default zoom and each site's zoom |
| 22.02 | Text-only zoom | ⏳ | |
| 22.03 | Minimum font size | ⏳ | |
| 22.04 | Custom fonts | ⏳ | |
| 22.05 | High-contrast compatibility | ⏳ | |
| 22.06 | Reduced-motion support | 🟡 | Kessel's own UI only |
| 22.07 | Screen-reader support | ⏳ | |
| 22.08 | Keyboard navigation | ⏳ | |
| 22.09 | Caret browsing | ⏳ | |
| 22.10 | Focus indicators | ⏳ | |
| 22.11 | Text-to-speech | ⏳ | |
| 22.12 | Caption support | 🧪 | Media controls -> captions (20.07) |
| 22.13 | Accessibility tree | ⏳ | |
| 22.14 | Color/contrast assistance | ⏳ | |
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
| 23.10 | Compact mode | ⏳ | |
| 23.11 | Normal mode | 🟢 | |
| 23.12 | Touch mode | ⏳ | |
| 23.13 | Sidebar | 🟢 | Rail + side panel |
| 23.14 | Vertical tabs | ✅ | See 2.30 |
| 23.15 | Custom fonts | ⏳ | |
| 23.16 | Custom UI scaling | 🟢 | Interface size |

### 24. Search engines

| # | Feature | Status | Notes |
|---|---|---|---|
| 24.01 | Default search engine | 🟢 | |
| 24.02 | Multiple search engines | 🟢 | Six built in |
| 24.03 | Custom search engines | ⏳ | |
| 24.04 | Search shortcuts (g cats, yt ..., wiki ...) | ⏳ | |
| 24.05 | Search suggestions | ⏳ | |
| 24.06 | Search history | ⏳ | |
| 24.07 | Private search | ⏳ | |
| 24.08 | Search engine per profile | ⏳ | |
| 24.09 | Search engine per window | ⏳ | |

### 25. Startup behavior

| # | Feature | Status | Notes |
|---|---|---|---|
| 25.01 | Open new-tab page | 🟢 | |
| 25.02 | Open homepage | 🟢 | |
| 25.03 | Open specific pages | ⏳ | |
| 25.04 | Restore previous session | 🟢 | |
| 25.05 | Restore selected windows | 🟡 | Every window of the last session comes back; picking some is not done yet |
| 25.06 | Open specific profile | ⏳ | |
| 25.07 | Continue where you left off | 🟢 | |
| 25.08 | Startup tab groups | ⏳ | |
| 25.09 | Startup workspace | ⏳ | |

### 26. Session management

| # | Feature | Status | Notes |
|---|---|---|---|
| 26.01 | Save session | ✅ | Each window's tabs are saved as they change (3.10) |
| 26.02 | Restore session | 🟡 | Last session on launch |
| 26.03 | Automatic session recovery | 🟡 | With "Keep tabs when Kessel closes" on, tabs come back after a crash too: they're saved as they change |
| 26.04 | Crash recovery | 🟡 | Toolbar watchdog |
| 26.05 | Session snapshots | ⏳ | |
| 26.06 | Save window | 🟡 | A window's tabs are saved with the session and when it closes |
| 26.07 | Restore window | 🟡 | Reopen closed window |
| 26.08 | Suspend session | ⏳ | |
| 26.09 | Export session | ⏳ | |
| 26.10 | Import session | ⏳ | |
| 26.11 | Cross-device session restore | ⏳ | |

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
| 30.01 | JavaScript: modern ECMAScript, Web/Shared/Service Workers, WebAssembly | ⏳ | |
| 30.02 | Graphics: Canvas, WebGL, WebGL2, WebGPU, SVG, CSS animations and transitions | ⏳ | |
| 30.03 | Storage: cookies, localStorage, sessionStorage, IndexedDB, Cache API, File System Access | ⏳ | |
| 30.04 | Communication: WebSockets, WebRTC, WebTransport, Server-Sent Events, Fetch, Streams | ⏳ | |
| 30.05 | Hardware: camera, microphone, Bluetooth, USB, HID, Serial, MIDI, NFC, sensors | ⏳ | |
| 30.06 | OS integration: clipboard, notifications, file picker, Share API, fullscreen, Wake Lock, Badging, credential management | ⏳ | |

### 31. Progressive Web Apps

| # | Feature | Status | Notes |
|---|---|---|---|
| 31.01 | Install website as app | ⏳ | |
| 31.02 | PWA manifest | ⏳ | |
| 31.03 | App icon | ⏳ | |
| 31.04 | Standalone mode | ⏳ | |
| 31.05 | Offline functionality | ⏳ | |
| 31.06 | Push notifications | ⏳ | |
| 31.07 | Background sync | ⏳ | |
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
| 32.02 | Permission prompts | ⏳ | |
| 32.03 | Notification blocking | ⏳ | |
| 32.04 | Per-site notification permissions | ⏳ | |
| 32.05 | Notification history | ⏳ | |
| 32.06 | Push notifications | ⏳ | |
| 32.07 | Notification sounds | ⏳ | |
| 32.08 | Notification actions | ⏳ | |
| 32.09 | Notification grouping | ⏳ | |
| 32.10 | Quiet notification prompts | ⏳ | |

### 33. Clipboard

| # | Feature | Status | Notes |
|---|---|---|---|
| 33.01 | Copy | ⏳ | |
| 33.02 | Paste | ⏳ | |
| 33.03 | Cut | ⏳ | |
| 33.04 | Rich-text clipboard | ⏳ | |
| 33.05 | Image clipboard | ⏳ | |
| 33.06 | Clipboard permissions | ⏳ | |
| 33.07 | Clipboard history integration | ⏳ | |

### 34. File system

| # | Feature | Status | Notes |
|---|---|---|---|
| 34.01 | File picker | ⏳ | |
| 34.02 | Folder picker | ⏳ | |
| 34.03 | Drag-and-drop files | ⏳ | |
| 34.04 | Upload directories | ⏳ | |
| 34.05 | Save file dialog | ⏳ | |
| 34.06 | File System Access API | ⏳ | |
| 34.07 | File reading | ⏳ | |
| 34.08 | File writing | ⏳ | |
| 34.09 | File handles | ⏳ | |
| 34.10 | Persistent file permissions | ⏳ | |

### 35. Hardware acceleration

| # | Feature | Status | Notes |
|---|---|---|---|
| 35.01 | GPU rendering | 🧪 | On by default; Settings -> Performance -> Use hardware acceleration (off draws everything with the processor; applies at the next start) |
| 35.02 | Hardware video decoding | 🧪 | kessel://gpu: for each video format, whether the graphics card or the processor decodes it |
| 35.03 | Hardware video encoding | 🧪 | Used by video calls; kessel://gpu shows which formats the graphics card encodes |
| 35.04 | WebGL acceleration | 🧪 | kessel://gpu shows the renderer and warns about a software fallback |
| 35.05 | WebGPU | 🧪 | The engine's WebGPU; kessel://gpu shows the power-saving and high-performance adapters |
| 35.06 | GPU rasterization | 🧪 | The engine's, with hardware acceleration on |
| 35.07 | Compositor acceleration | 🧪 | The engine's, with hardware acceleration on (off: software compositing) |
| 35.08 | Battery-aware GPU behavior | 🟡 | Settings -> Performance -> Graphics card: Automatic picks the power-saving card when Kessel starts on battery -- decided at start, not while running; or always power-saving / high-performance |
| 35.09 | Graphics diagnostics | 🧪 | kessel://gpu (Settings -> Performance, Help, or type "gpu" in the address bar): acceleration, renderer, WebGL/WebGPU, display, video and audio formats, DRM, Web Audio, WebRTC; Copy report |

### 36. Performance

| # | Feature | Status | Notes |
|---|---|---|---|
| 36.01 | Memory saver | ✅ | Sleeping tabs and "Save memory in background tabs" (2.39, 2.44); Settings -> Performance |
| 36.02 | Sleeping tabs | 🟢 | |
| 36.03 | Energy saver | ⏳ | |
| 36.04 | CPU throttling | ✅ | Background tabs are paused after a while (2.41) |
| 36.05 | Background-tab throttling | ✅ | See 2.44 |
| 36.06 | Hardware acceleration | 🧪 | See 35.01 |
| 36.07 | Cache optimization | ⏳ | |
| 36.08 | Prefetching | ⏳ | |
| 36.09 | Pre-rendering | ⏳ | |
| 36.10 | DNS caching | 🌐 | The engine's (Chromium's) network stack |
| 36.11 | Connection reuse | 🌐 | The engine's network stack |
| 36.12 | HTTP/2 multiplexing | 🌐 | The engine's network stack |
| 36.13 | HTTP/3/QUIC | 🌐 | The engine's network stack |
| 36.14 | Image optimization | ⏳ | |
| 36.15 | Lazy loading | 🌐 | loading="lazy" images and frames |
| 36.16 | Process management | 🌐 | The engine's processes; Shift+Esc shows them (39.16) |
| 36.17 | Site isolation | 🌐 | The engine's site isolation |

### 37. Cache

| # | Feature | Status | Notes |
|---|---|---|---|
| 37.01 | HTTP cache | 🌐 | |
| 37.02 | Memory cache | 🌐 | |
| 37.03 | Disk cache | 🌐 | |
| 37.04 | Cache inspection | ⏳ | |
| 37.05 | Cache clearing | ✅ | Clear browsing data -> Cached images and files, for a time range |
| 37.06 | Per-site cache deletion | ⏳ | |
| 37.07 | Full cache deletion | ✅ | Clear browsing data -> All time |
| 37.08 | Cache-control handling | 🌐 | Ctrl+F5 skips it |
| 37.09 | Offline cache | ⏳ | |
| 37.10 | Service-worker cache | ⏳ | |

### 38. Developer / experimental controls

| # | Feature | Status | Notes |
|---|---|---|---|
| 38.01 | Experimental features | ⏳ | |
| 38.02 | Feature flags | ⏳ | |
| 38.03 | Browser experiments | ⏳ | |
| 38.04 | Experimental APIs | ⏳ | |
| 38.05 | Rendering flags | ⏳ | |
| 38.06 | GPU flags | ⏳ | |
| 38.07 | Networking flags | ⏳ | |
| 38.08 | JavaScript flags | ⏳ | |
| 38.09 | Developer mode | ⏳ | |
| 38.10 | Internal diagnostics | ⏳ | |
| 38.11 | Browser logs | ⏳ | |
| 38.12 | Crash logs | ⏳ | |
| 38.13 | Performance diagnostics | ⏳ | |

### 39. Browser information & diagnostics

| # | Feature | Status | Notes |
|---|---|---|---|
| 39.01 | Browser version | 🟢 | Settings -> About |
| 39.02 | Engine version | ✅ | Help and Settings -> About show the WebView2 version |
| 39.03 | OS information | 🟡 | kessel://gpu: Windows and the architecture; not the Windows version yet |
| 39.04 | GPU information | 🧪 | kessel://gpu: the renderer, WebGL and WebGPU adapters |
| 39.05 | CPU information | 🟡 | kessel://gpu: the number of processor threads |
| 39.06 | Memory information | ⏳ | |
| 39.07 | Installed codecs | 🧪 | kessel://gpu: video and audio formats, hardware decoding, DRM |
| 39.08 | Supported APIs | ⏳ | |
| 39.09 | Network information | ⏳ | |
| 39.10 | Connection status | ⏳ | |
| 39.11 | Crash reports | ⏳ | |
| 39.12 | Diagnostics page | 🟡 | kessel://gpu covers graphics and media |
| 39.13 | Certificate information | ⏳ | |
| 39.14 | Storage usage | ⏳ | |
| 39.15 | Site permissions | ⏳ | |
| 39.16 | Process manager | ✅ | Shift+Esc: the engine's task manager (end a stuck page's process) |

### 40. Built-in task management

| # | Feature | Status | Notes |
|---|---|---|---|
| 40.01 | Tab CPU usage | ⏳ | |
| 40.02 | Tab RAM usage | ⏳ | |
| 40.03 | Extension CPU usage | ⏳ | |
| 40.04 | Extension RAM usage | ⏳ | |
| 40.05 | Process termination | ⏳ | |
| 40.06 | Suspended-tab management | ⏳ | |
| 40.07 | GPU process information | ⏳ | |
| 40.08 | Network process information | ⏳ | |
| 40.09 | Browser process information | ⏳ | |

### 41. Screenshots & capture

| # | Feature | Status | Notes |
|---|---|---|---|
| 41.01 | Full-page screenshot | ⏳ | |
| 41.02 | Visible-area screenshot | ⏳ | |
| 41.03 | Selected-area screenshot | ⏳ | |
| 41.04 | Screenshot to clipboard | ⏳ | |
| 41.05 | Screenshot annotation | ⏳ | |
| 41.06 | Screen recording | ⏳ | |
| 41.07 | Tab recording | ⏳ | |
| 41.08 | Window recording | ⏳ | |
| 41.09 | Webcam recording | ⏳ | |
| 41.10 | Audio recording | ⏳ | |
| 41.11 | Developer screenshot tools | ⏳ | |

### 42. Sharing

| # | Feature | Status | Notes |
|---|---|---|---|
| 42.01 | Share current page | ⏳ | |
| 42.02 | Share selected text | ⏳ | |
| 42.03 | Share image | ⏳ | |
| 42.04 | Share file | ⏳ | |
| 42.05 | OS share sheet | ⏳ | |
| 42.06 | QR-code sharing | ⏳ | |
| 42.07 | Send to another device | ⏳ | |
| 42.08 | Send tab to phone | ⏳ | |
| 42.09 | Send tab to computer | ⏳ | |

### 43. Mobile-specific features

| # | Feature | Status | Notes |
|---|---|---|---|
| 43.01 | Bottom address bar | ⏳ | |
| 43.02 | One-handed mode | ⏳ | |
| 43.03 | Gesture navigation | ⏳ | |
| 43.04 | Pull-to-refresh | ⏳ | |
| 43.05 | Tab grid | ⏳ | |
| 43.06 | Tab groups | ⏳ | |
| 43.07 | Mobile tab synchronization | ⏳ | |
| 43.08 | Send tab to desktop | ⏳ | |
| 43.09 | Mobile downloads | ⏳ | |
| 43.10 | Mobile reader mode | ⏳ | |
| 43.11 | Mobile screenshot | ⏳ | |
| 43.12 | Mobile sharing | ⏳ | |
| 43.13 | Mobile autofill | ⏳ | |
| 43.14 | Mobile passkeys | ⏳ | |
| 43.15 | Biometric browser locking | ⏳ | |

### 44. Desktop-specific features

| # | Feature | Status | Notes |
|---|---|---|---|
| 44.01 | Multiple windows | ✅ | See 3.01 |
| 44.02 | Keyboard shortcuts | ✅ | See the shortcut table |
| 44.03 | Full developer tools | 🌐 | Edge DevTools (F12) |
| 44.04 | Extensions | ⏳ | |
| 44.05 | Vertical tabs | ✅ | See 2.30 |
| 44.06 | Sidebars | 🟢 | |
| 44.07 | Workspaces | ⏳ | |
| 44.08 | Profiles | 🟡 | Accounts |
| 44.09 | Window management | ⏳ | |
| 44.10 | Desktop notifications | ⏳ | |
| 44.11 | Hardware acceleration | 🧪 | See 35.01 |
| 44.12 | Advanced downloads | ⏳ | |
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
| 45.09 | New profile | ⏳ | |
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
| 45.23 | Picture-in-picture | ⏳ | |
| 45.24 | Screenshot | ⏳ | |
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
| 46.06 | Mouse gestures | ⏳ | |
| 46.07 | Trackpad gestures | ⏳ | |
| 46.08 | Two-finger navigation | ⏳ | |
| 46.09 | Pinch zoom | ✅ | Pinch on a touchpad or touchscreen: the engine's zoom, kept per site (22.01) |
| 46.10 | Swipe navigation | ⏳ | |
| 46.11 | Context menus | 🌐 | On pages: the engine's menu; on tabs, groups and the tab strip: Kessel's own (2.x) |
| 46.12 | Link preview | ⏳ | |

### 47. Context menus

| # | Feature | Status | Notes |
|---|---|---|---|
| 47.01 | Page: back, forward, reload | 🌐 | The engine's page menu |
| 47.02 | Page: save, print | 🌐 | The engine's page menu: Save as, Print |
| 47.03 | Page: translate, screenshot | ⏳ | |
| 47.04 | Link: open in new tab / new window / private window | ⏳ | |
| 47.05 | Link: copy link, copy link text | ⏳ | |
| 47.06 | Link: download linked file, search link | ⏳ | |
| 47.07 | Text: copy, search | ⏳ | |
| 47.08 | Text: translate, define, speak, share | ⏳ | |
| 47.09 | Image: open, save, copy, copy address | ⏳ | |
| 47.10 | Image: search image | ⏳ | |

### 48. AI features

| # | Feature | Status | Notes |
|---|---|---|---|
| 48.01 | AI page summarization | 🟡 | Right-click a page: Ask AI about this page -- your assistant (side panel) is asked to summarize it |
| 48.02 | AI webpage explanation | 🟡 | The same, then ask it anything about the page |
| 48.03 | Ask about selected text | ✅ | Pick text, right-click: Ask AI about this -- the text goes to your assistant |
| 48.04 | AI search | ⏳ | |
| 48.05 | AI tab organization | ⏳ | |
| 48.06 | AI tab grouping | ⏳ | |
| 48.07 | AI history search | ⏳ | |
| 48.08 | AI browsing assistant | ✅ | Your AI assistant in the side panel, beside the page |
| 48.09 | AI writing assistant | ⏳ | |
| 48.10 | AI rewriting | ⏳ | |
| 48.11 | AI translation | ⏳ | |
| 48.12 | AI comparison | ⏳ | |
| 48.13 | AI shopping assistance | ⏳ | |
| 48.14 | AI research mode | ⏳ | |
| 48.15 | AI webpage extraction | ⏳ | |
| 48.16 | AI PDF summarization | ⏳ | |
| 48.17 | AI screenshot understanding | ⏳ | |
| 48.18 | AI image understanding | ⏳ | |
| 48.19 | AI command interface | ⏳ | |
| 48.20 | Natural-language browser commands | ⏳ | |

### 49. Shopping

| # | Feature | Status | Notes |
|---|---|---|---|
| 49.01 | Price comparison | ⏳ | |
| 49.02 | Price tracking | ⏳ | |
| 49.03 | Price history | ⏳ | |
| 49.04 | Coupon detection | ⏳ | |
| 49.05 | Automatic coupon application | ⏳ | |
| 49.06 | Product comparison | ⏳ | |
| 49.07 | Shopping lists | ⏳ | |
| 49.08 | Store credibility information | ⏳ | |
| 49.09 | Purchase history integration | ⏳ | |
| 49.10 | Delivery tracking | ⏳ | |

### 50. Media & entertainment extras

| # | Feature | Status | Notes |
|---|---|---|---|
| 50.01 | Video enhancement | ⏳ | |
| 50.02 | Picture-in-picture | ⏳ | |
| 50.03 | Playback controls | ⏳ | |
| 50.04 | Volume normalization | ⏳ | |
| 50.05 | Media-key support | ⏳ | |
| 50.06 | Casting | ⏳ | |
| 50.07 | Chromecast-style casting | ⏳ | |
| 50.08 | AirPlay-style integration | ⏳ | |
| 50.09 | Subtitle customization | ⏳ | |
| 50.10 | Theater mode | ⏳ | |
| 50.11 | Fullscreen mode | ⏳ | |

### 51. Privacy-focused advanced features

| # | Feature | Status | Notes |
|---|---|---|---|
| 51.01 | Tor-style routing integration | ⏳ | |
| 51.02 | Private windows with stronger isolation | ⏳ | |
| 51.03 | Fingerprint resistance | 🟢 | |
| 51.04 | Tracker blocking | 🟢 | |
| 51.05 | Ad blocking | 🟢 | |
| 51.06 | Cookie isolation | 🟢 | Accounts |
| 51.07 | Container tabs | 🟢 | Accounts |
| 51.08 | Temporary identities | ⏳ | |
| 51.09 | Temporary email integration | ⏳ | |
| 51.10 | VPN integration | ⏳ | |
| 51.11 | Proxy integration | ⏳ | |
| 51.12 | Encrypted DNS | ⏳ | |
| 51.13 | Anti-bounce tracking | ⏳ | |
| 51.14 | URL tracking-parameter removal | 🟢 | |

### 52. Import / export

| # | Feature | Status | Notes |
|---|---|---|---|
| 52.01 | Import bookmarks | 🟢 | |
| 52.02 | Import history | ⏳ | |
| 52.03 | Import passwords | 🟢 | |
| 52.04 | Import cookies where supported | 🟢 | |
| 52.05 | Import settings | ⏳ | |
| 52.06 | Import open tabs | ⏳ | |
| 52.07 | Import extensions | ⏳ | |
| 52.08 | Import from Chrome | 🟢 | |
| 52.09 | Import from Edge | ⏳ | |
| 52.10 | Import from Firefox | ⏳ | |
| 52.11 | Import from Safari | ⏳ | |
| 52.12 | Import HTML bookmarks | ⏳ | |
| 52.13 | Export bookmarks | ⏳ | |
| 52.14 | Export passwords | ⏳ | |
| 52.15 | Export history | ⏳ | |
| 52.16 | Export settings | ⏳ | |
| 52.17 | Export sessions | ⏳ | |

### 53. Updates

| # | Feature | Status | Notes |
|---|---|---|---|
| 53.01 | Automatic browser updates | ⏳ | |
| 53.02 | Background updates | ⏳ | |
| 53.03 | Update notifications | ⏳ | |
| 53.04 | Update channels (stable, beta, developer, canary) | ⏳ | |
| 53.05 | Extension updates | ⏳ | |
| 53.06 | Component updates | ⏳ | |
| 53.07 | Security updates | ⏳ | |
| 53.08 | Rollback/recovery | ⏳ | |
| 53.09 | Update verification | ⏳ | |

### 54. Crash handling

| # | Feature | Status | Notes |
|---|---|---|---|
| 54.01 | Crash detection | 🟡 | Toolbar only |
| 54.02 | Automatic recovery | 🟡 | Toolbar only |
| 54.03 | Session restoration | 🟡 | As 26.03 |
| 54.04 | Crash reports | ⏳ | |
| 54.05 | Error pages | ⏳ | |
| 54.06 | Safe mode | ⏳ | |
| 54.07 | Extension-disable recovery | ⏳ | |
| 54.08 | GPU crash recovery | ⏳ | |
| 54.09 | Corrupted-profile recovery | ⏳ | |

### 55. Browser settings

| # | Feature | Status | Notes |
|---|---|---|---|
| 55.01 | General: startup, homepage, new tab | 🟡 | Homepage + restore tabs |
| 55.02 | General: default browser | ⏳ | |
| 55.03 | General: downloads | ⏳ | |
| 55.04 | General: appearance | 🟢 | |
| 55.05 | General: language | ⏳ | |
| 55.06 | Search: default engine, suggestions, shortcuts, private search | 🟡 | Default engine only |
| 55.07 | Privacy: cookies, tracking, fingerprinting, history, cache, site data, DNS, Do Not Track | 🟡 | Tracking + fingerprinting |
| 55.08 | Security: safe browsing, HTTPS-only, certificates, passwords, passkeys, security keys | 🟡 | HTTPS upgrade + passwords |
| 55.09 | Permissions: location, camera, microphone, notifications, pop-ups, autoplay, downloads, clipboard, sensors, USB, Bluetooth | ⏳ | |
| 55.10 | Performance: hardware acceleration, memory saver, energy saver, tab sleeping, preloading | 🟡 | Tab sleeping |
| 55.11 | Sync: accounts, devices, data types, encryption, status | ⏳ | |
| 55.12 | Profiles: create, delete, switch, customize, default | 🟡 | Accounts popup |
| 55.13 | Extensions: installed, permissions, developer mode, store | ⏳ | |
| 55.14 | Accessibility: zoom, fonts, reader mode, screen reader, reduced motion | ⏳ | |

### 56. Account system

| # | Feature | Status | Notes |
|---|---|---|---|
| 56.01 | Account login | ⏳ | |
| 56.02 | Account creation | ⏳ | |
| 56.03 | Email verification | ⏳ | |
| 56.04 | MFA | ⏳ | |
| 56.05 | Passkeys | ⏳ | |
| 56.06 | Device management | ⏳ | |
| 56.07 | Session management | ⏳ | |
| 56.08 | Sync | ⏳ | |
| 56.09 | Cloud backup | ⏳ | |
| 56.10 | Encrypted browser data | ⏳ | |
| 56.11 | Remote logout | ⏳ | |
| 56.12 | Device removal | ⏳ | |
| 56.13 | Account recovery | ⏳ | |
| 56.14 | Privacy dashboard | ⏳ | |

### 57. Browser lock

| # | Feature | Status | Notes |
|---|---|---|---|
| 57.01 | PIN lock | ⏳ | |
| 57.02 | Password lock | ⏳ | |
| 57.03 | Windows Hello | ⏳ | |
| 57.04 | Fingerprint | ⏳ | |
| 57.05 | Face unlock | ⏳ | |
| 57.06 | Lock private tabs | ⏳ | |
| 57.07 | Lock profiles | ⏳ | |
| 57.08 | Lock password manager | 🟢 | Vault auto-lock |
| 57.09 | Lock browser on startup | ⏳ | |
| 57.10 | Automatic lock after inactivity | ⏳ | |

### 58. Search / history intelligence

| # | Feature | Status | Notes |
|---|---|---|---|
| 58.01 | Semantic history search | ⏳ | |
| 58.02 | Search by title | ⏳ | |
| 58.03 | Search by URL | ⏳ | |
| 58.04 | Search by text content | ⏳ | |
| 58.05 | Search by date | ⏳ | |
| 58.06 | Search by domain | ⏳ | |
| 58.07 | Search by tab | ⏳ | |
| 58.08 | Search by workspace | ⏳ | |
| 58.09 | Search by profile | ⏳ | |
| 58.10 | Search screenshots | ⏳ | |
| 58.11 | Search downloaded files | ⏳ | |
| 58.12 | Search bookmarks | ⏳ | |
| 58.13 | Search reading list | ⏳ | |

### 59. Offline functionality

| # | Feature | Status | Notes |
|---|---|---|---|
| 59.01 | Offline page cache | ⏳ | |
| 59.02 | Offline reading | ⏳ | |
| 59.03 | Offline PWAs | ⏳ | |
| 59.04 | Service workers | ⏳ | |
| 59.05 | Background synchronization | ⏳ | |
| 59.06 | Cached resources | ⏳ | |
| 59.07 | Offline error page | ⏳ | |
| 59.08 | Offline downloads | ⏳ | |
| 59.09 | Network recovery | ⏳ | |
| 59.10 | Automatic retry | ⏳ | |

### 60. Web standards compatibility

| # | Feature | Status | Notes |
|---|---|---|---|
| 60.01 | HTML, CSS, JavaScript, WebAssembly | ⏳ | |
| 60.02 | WebGL, WebGPU | ⏳ | |
| 60.03 | WebRTC, WebSockets, Fetch, Streams | ⏳ | |
| 60.04 | Web Workers, Service Workers, IndexedDB | ⏳ | |
| 60.05 | Web Crypto, WebAuthn | ⏳ | |
| 60.06 | Notifications, Push API | ⏳ | |
| 60.07 | Payment Request | ⏳ | |
| 60.08 | Clipboard API, File System Access, Web Share | ⏳ | |
| 60.09 | Fullscreen API, Wake Lock | ⏳ | |
| 60.10 | Web Bluetooth, WebUSB, WebHID, Web Serial, MIDI | ⏳ | |
| 60.11 | Sensors, Geolocation | ⏳ | |
| 60.12 | Media APIs, Accessibility APIs | ⏳ | |

### 61. Developer-facing browser architecture

| # | Feature | Status | Notes |
|---|---|---|---|
| 61.01 | Browser, renderer, GPU, network and storage processes | ⏳ | |
| 61.02 | JavaScript engine, JIT, WebAssembly engine | ⏳ | |
| 61.03 | Rendering engine: HTML/CSS parsers, DOM, layout, paint, compositor, GPU backend | ⏳ | |
| 61.04 | Networking stack, DNS resolver, certificate verifier, HTTP cache, cookie store | ⏳ | |
| 61.05 | Permission manager | ⏳ | |
| 61.06 | Extension system | ⏳ | |
| 61.07 | Profile manager | 🟢 | Accounts |
| 61.08 | Sync engine | ⏳ | |
| 61.09 | Password manager | 🟢 | |
| 61.10 | Download manager | 🟡 | |
| 61.11 | History database | 🟢 | |
| 61.12 | Bookmark database | 🟢 | |
| 61.13 | DevTools | 🌐 | F12: the engine's DevTools (section 29) |
| 61.14 | Crash reporter | ⏳ | |
| 61.15 | Update system | ⏳ | |
| 61.16 | Sandbox, site-isolation system, IPC system | ⏳ | |
| 61.17 | Accessibility layer | ⏳ | |

### 62. "Crazy advanced" features

| # | Feature | Status | Notes |
|---|---|---|---|
| 62.01 | AI-native command bar | ⏳ | |
| 62.02 | AI semantic history | ⏳ | |
| 62.03 | AI tab organization | ⏳ | |
| 62.04 | AI workspace creation | ⏳ | |
| 62.05 | Automatic session recovery | ⏳ | |
| 62.06 | Automatic tab cleanup | 🟢 | Idle tab discarding |
| 62.07 | Automatic duplicate-tab detection | ⏳ | |
| 62.08 | Tab memory visualization | ⏳ | |
| 62.09 | Tab dependency detection | ⏳ | |
| 62.10 | Website change monitoring | ⏳ | |
| 62.11 | Page-change notifications | ⏳ | |
| 62.12 | Built-in notes | ⏳ | |
| 62.13 | Notes attached to URLs | ⏳ | |
| 62.14 | Web annotations | ⏳ | |
| 62.15 | Collaborative tabs | ⏳ | |
| 62.16 | Collaborative workspaces | ⏳ | |
| 62.17 | Shared sessions | ⏳ | |
| 62.18 | Cloud browser profiles | ⏳ | |
| 62.19 | Encrypted browser backup | ⏳ | |
| 62.20 | Temporary browser identities | ⏳ | |
| 62.21 | Website-specific containers | 🟡 | Accounts per tab |
| 62.22 | Per-site browser personalities | ⏳ | |
| 62.23 | Built-in automation | ⏳ | |
| 62.24 | Browser macros | ⏳ | |
| 62.25 | Workflow automation | ⏳ | |
| 62.26 | Command palette | ⏳ | |
| 62.27 | Keyboard-first UI | ⏳ | |
| 62.28 | Power-user settings | ⏳ | |
| 62.29 | Browser telemetry dashboard | ⏳ | |
| 62.30 | Privacy dashboard | ⏳ | |
| 62.31 | Permission dashboard | ⏳ | |
| 62.32 | Site resource dashboard | ⏳ | |

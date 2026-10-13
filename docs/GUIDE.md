<!-- Written by scripts/build-guide.mjs from tauri-browser/src/shared/guide.js and features.js -- edit those, then run it. -->

# Kessel user guide

Kessel is a light, fast browser for Windows. This guide is also inside Kessel: press **F1** for Help, or open Settings → All features.

## Contents

- [Getting started](#getting-started)
- [Shields & privacy](#shields--privacy)
- [Safety & passwords](#safety--passwords)
- [VPN & network](#vpn--network)
- [Side panel & workspaces](#side-panel--workspaces)
- [Reading & research](#reading--research)
- [Media & capture](#media--capture)
- [Apps & downloads](#apps--downloads)
- [Look & feel](#look--feel)
- [Speed & battery](#speed--battery)
- [Every feature](#every-feature)

## Getting started

Kessel is a light, fast browser for Windows with Shields, a password vault, a VPN, workspaces and a side panel built in. These are the first things worth knowing.

- **Bring your things along.** Bookmarks, history, passwords, open tabs, cookies and extensions come straight from Chrome, Edge, Brave, Opera, Opera GX, Vivaldi or Firefox. Settings → Import (`kessel://settings/import`)
- **Make it your default browser.** Settings → Search & Startup → Default browser (`kessel://settings/search`) registers Kessel and opens Windows' Default apps page at it.
- **Every command in one place.** Press <kbd>F2</kbd> for the command palette: every command Kessel has, searchable, recent ones first. Most of this guide is a few letters away there.
- **Ask the address bar.** Besides addresses and searches it answers sums (`15% of 80`), conversions (`10 km to miles`, `100 usd to eur`), definitions (`define serendipity`) and the time anywhere -- and runs commands by name (`clear cache`).
- **Keep your tabs.** Turn on "Keep tabs when Kessel closes" and your windows, tabs, groups and workspaces come back next time. Settings → Tabs (`kessel://settings/tabs`)
- **Your keys, your way.** Every shortcut can be changed, and mouse gestures (hold the right button and draw) run commands too. Settings → Keyboard & Mouse (`kessel://settings/shortcuts`)
- **Everything else.** Settings → All features lists every feature with how to use it. Open it (`kessel://settings/features`)

## Shields & privacy

Kessel blocks ads and trackers on every site by itself, and sends no telemetry.

- **Shields.** Blocks ads, trackers, cryptominers and malicious sites, upgrades connections to HTTPS, strips tracking codes from links and skips click-tracking redirect pages. The shield in the address bar shows what it blocked and turns it off for one site.
- **Fingerprinting.** Shields gives sites slightly different answers about your canvas, audio, graphics card, processor and screen, so they can't recognise you by your PC.
- **More filter lists.** Cookie notices and other annoyances have optional lists, and you can add any filter list by its address. Settings → Privacy (`kessel://settings/privacy`)
- **Hide something for good.** Command palette → **Hide an element**, then click what you never want to see on that site again. Undo it in Settings → Page tools.
- **Cookies.** Third-party cookies are blocked by default. Per site, cookies can be allowed, kept until Kessel closes, or blocked; every cookie can be looked at and edited. Settings → Cookies & site data (`kessel://settings/cookies`)
- **Forget a site.** Settings → Privacy → **Forget these sites when you close them**: a site's cookies and storage go when its last tab closes.
- **Private windows.** <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd>: a fresh identity -- no history, cookies or sign-ins kept once the last private window closes.
- **Privacy dashboard.** What Shields blocked day by day and per site, your protections, what sites may use, and every connection Kessel makes by itself. `kessel://privacy`
- **Clear browsing data.** <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Del</kbd>: history, cookies, cache and more, for the last hour or any time -- or by itself whenever Kessel closes. Open it (`kessel://settings/clear`)

## Safety & passwords

Passwords, cards and the lock screen, and how Kessel keeps you off dangerous sites.

- **The password vault.** Encrypted with your master password. After you sign in somewhere Kessel offers to save the password; on that site's sign-in page a chip under the field fills it in when you click it. `kessel://passwords` (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd>)
- **Password checks.** The Passwords page flags weak and reused passwords, and -- only when you ask -- breached ones: just 5 characters of each password's SHA-1 hash ever leave the computer.
- **Addresses & cards.** Filled in from a list under the field that only you see; cards are encrypted for your Windows account, and their security code is never kept. Settings → Addresses & cards (`kessel://settings/autofill`)
- **Passkeys and security keys.** Sites that use passkeys or USB/NFC security keys work through Windows Hello, which keeps the passkeys.
- **Lock Kessel.** A PIN, a password or Windows Hello locks every window: when Kessel starts, after you've been away a while, or just your private windows. Settings → Security (`kessel://settings/security`)
- **Dangerous sites and downloads.** Malware, phishing and badware lists are checked on this PC -- nothing is sent anywhere -- and turn into a warning page. Risky downloads wait for you to keep or discard them.
- **HTTPS-only.** Settings → Security: every site opened over https, with a warning before one that has none. Plain http sites always show a red "Not secure".
- **Site info.** Click the lock in the address bar: the connection, the certificate, the site's cookies and data, and its permissions.

## VPN & network

A VPN, secure DNS and proxies built into Kessel -- for Kessel's own traffic, nothing else on the PC.

- **The VPN button.** Kessel runs WireGuard itself: import any provider's WireGuard configs, or enter your Surfshark key for every Surfshark location. SOCKS5 and HTTP servers work too. It turns on and off at once, without DNS leaks, and nothing goes around it when the server is down. Settings → Network (`kessel://settings/network`)
- **Secure DNS.** DNS over HTTPS or TLS: Cloudflare, Google, Quad9 or your own server. "Only secure DNS" never falls back to your network's.
- **Proxies.** No proxy, Windows' setting, your own HTTP or SOCKS5 server, or a PAC script -- and single sites through a proxy of their own, or straight past the VPN.
- **Several accounts side by side.** Accounts give tabs their own cookie jars: be signed in to the same site as several people at once, each account's tabs in its colour. Use the person button in the address bar.
- **Profiles.** A completely separate Kessel -- its own history, passwords, settings, extensions and network -- with a desktop shortcut of its own. Settings → Profiles (`kessel://settings/profiles`) (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd>)

## Side panel & workspaces

The rail at the side of the window holds your workspaces, panels and pinned sites.

- **Workspaces.** Separate sets of tabs in one window -- work, study, games. The buttons at the top of the rail switch between them; the others' tabs sleep until you come back, and each workspace tints the window in its colour.
- **The side panel.** Bookmarks, History, the Reading list, Notes, Search and Extensions, beside the page you're reading. Drag its edge to resize it.
- **Pinned sites.** Any site -- chat, music, mail -- can live in the side panel. Settings → Pinned Sites (`kessel://settings/pinned`)
- **An AI assistant.** ChatGPT, Claude, Gemini, Copilot, Perplexity, Le Chat or your own, in the side panel. Right-click a page or selected text → **Ask AI about this**. Settings → Side panel (`kessel://settings/sidebar`)
- **Notes.** Side panel → Notes: saved as you type, pinned, linked to the page you were on. Right-click selected text → **Save selection to notes**.
- **Search everything.** Side panel → Search looks through open tabs, bookmarks, the reading list, notes and history at once.

## Reading & research

Tools for reading, keeping and understanding what's on the web.

- **Reader view.** <kbd>F9</kbd>: just the article, nothing of the site running, with minutes to read -- and **Read aloud**, paragraph by paragraph.
- **Reading list.** Right-click a page or a link → **Add to reading list**. A page saved while it's open is kept whole, to read offline.
- **Highlights and notes.** Select text and press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>: it's highlighted again whenever you come back. Click a highlight to add a note.
- **Spelling and grammar.** Misspelled words get a red underline, from Windows' own dictionaries (nothing leaves the PC); right-click for suggestions. Grammar checking (LanguageTool) can be turned on. Settings → Page tools (`kessel://settings/tools`)
- **Translate.** A Translate chip appears on pages in another language: translate once, always for that language, or never. Right-click selected text → **Translate**, or a word → **Define**.
- **PDFs.** Kessel's own PDF viewer: thumbnails, search, highlight, draw, add text and pictures, fill in forms, sign, and present full screen. What you add is saved in the PDF.
- **Feeds and watched pages.** Follow a site's RSS or Atom feed, or have Kessel watch any page and tell you when its text changes. `kessel://feeds`
- **Peek at a link.** Right-click a link → **Peek at link** opens it in a small floating window, without leaving your page.
- **Find pages by what they said.** Settings → History → **Remember what pages say** (off by default): History then finds pages by any words on them.

## Media & capture

Control sound and video in any tab, and capture what's on screen.

- **Media controls.** The music-note button beside the menu shows every tab playing sound: play, pause, skip, seek, speed, captions and audio tracks -- without switching tabs.
- **Picture-in-picture.** <kbd>Alt</kbd>+<kbd>P</kbd> floats the tab's video in its own always-on-top window. Command palette → **Theater mode** fills the tab with it instead.
- **Only one tab plays.** Settings → Tabs → **Only the tab you're on plays sound** mutes the rest. Command palette → **Pause everything** stops every page and sound at once.
- **Subtitles your way.** Settings → Accessibility → Subtitles: captions bigger, in another colour, on another background, on every site.
- **Screenshots.** <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> takes what's in view; the command palette takes the whole page or a part you drag. The editor has a pen, highlighter, arrows, boxes, text, blur and crop.
- **Share.** The share button in the address bar copies the link (also as Markdown) or a QR code, or opens Windows' Share window.

## Apps & downloads

Install sites as apps, add extensions and keep track of what you download.

- **Install a site as an app.** Menu → **Install as app**: a Start menu entry and a window of its own, with its badge, jump list and file types. Settings → Apps (`kessel://settings/apps`)
- **Extensions.** On an extension's page in the Chrome Web Store or Edge Add-ons, click **Add to Kessel** in the address bar. Kessel shows what it may do first, and keeps it up to date. Settings → Extensions (`kessel://settings/extensions`)
- **Downloads.** <kbd>Ctrl</kbd>+<kbd>J</kbd>: pause, resume, retry, search and sort. Kessel can ask where to save each file, or sort downloads into Pictures, Videos, Documents and more. Settings → Downloads (`kessel://settings/downloads`)
- **Notifications.** Sites' notifications are Kessel's own cards, stacked per site, with a history. Allow or block them per site. Settings → Site permissions (`kessel://settings/permissions`)

## Look & feel

Make Kessel look and feel the way you want.

- **Styles and colours.** Pick a style and its colours, a wallpaper, light or dark (or follow Windows). Chrome themes' colours work too. Settings → Appearance (`kessel://settings/appearance`)
- **Tabs on the side.** Settings → Tabs → Tab layout: **Side** puts the tabs in a column beside the page, resizable and collapsible to icons.
- **Compact or touch.** Settings → Appearance → Density: Compact for more page, Touch for bigger targets. The toolbar's buttons can be hidden and moved.
- **Split view.** Right-click a tab → **Open side by side with this tab**, or drag a tab to the page's edge: two tabs in one window.
- **Make a site yours.** Command palette → **Change this site**: your own CSS for it. Colour filters (dark, sepia, grayscale, more contrast…) work per site or everywhere.
- **Easier to read.** Text size, the smallest font size, your own fonts, less motion and a bold keyboard outline. Settings → Accessibility (`kessel://settings/accessibility`)

## Speed & battery

Kessel keeps itself light without you having to think about it.

- **Sleeping tabs.** Background tabs are slowed, then paused, then put to sleep to free memory, and wake up when you come back. Tabs playing sound and sites you list are left alone. Settings → Performance (`kessel://settings/performance`)
- **Energy saver.** On battery (or always), background tabs pause sooner and Kessel's own animations stop. A leaf in the toolbar says it's on.
- **What's using memory.** Rest the mouse on a tab to see its memory and CPU. <kbd>Shift</kbd>+<kbd>Esc</kbd> opens the task manager: every process, with buttons to end it or put its tabs to sleep.
- **Forgotten tabs.** Settings → Tabs → **Close tabs you've forgotten** tidies up tabs you haven't touched in days.
- **When something goes wrong.** A crashed tab says so and reloads in a click; if the engine stops, Kessel comes back with your tabs. Safe mode (`kessel.exe --safe-mode`) starts without extensions or the graphics card.
- **Look under the hood.** `kessel://diagnostics` (this PC, network, storage, crash reports) and `kessel://gpu` (graphics and video formats), each with a report to copy.

## Every feature

Everything Kessel does, and how to use it -- as in Settings → All features.

### Tabs

| Feature | How |
| --- | --- |
| New / close / reopen tab | Ctrl+T, Ctrl+W, Ctrl+Shift+T (also brings back a closed window). |
| Switch tabs | Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+1..8, Ctrl+9 for the last one. |
| Tab menu | Right-click a tab: reload, duplicate, pin, mute, sleep, group, bookmark, copy link, move, close others / left / right. |
| Pinned tabs | Tab menu → Pin tab. Icon only, in front, can't be closed by accident. |
| Mute a tab | Click the speaker on the tab, or Ctrl+M. |
| Pick several tabs | Ctrl+click or Shift+click tabs; the tab menu and Ctrl+W then act on all of them. |
| Tab groups | Tab menu → Add tab to new group, type a name. Click the name to fold, double-click to rename, right-click for colour, save, ungroup. |
| Saved groups | Group menu → Save group. It appears on the bookmarks bar; click it to reopen. |
| Group by site | Tab menu → Group tabs by site, or Settings → Tabs → Group tabs from the same site. |
| Tab search | Ctrl+Shift+A or the arrow beside the tabs: every tab, sleeping and closed ones too. |
| Vertical tabs | Settings → Tabs → Tab layout → Side. Drag the edge to resize, the arrow collapses it. |
| Hover cards | Rest the mouse on a tab: title, preview, memory. Settings → Tabs to turn parts off. |
| Keep tabs when closing | Settings → Tabs → Keep tabs when Kessel closes. |
| Sleeping / paused tabs | Automatic for tabs you haven't used; tune in Settings → Performance. Tab menu → Put to sleep. |
| Energy saver | On battery (or always: Settings → Performance): background tabs pause after a minute and sleep after 15, and Kessel's own animations stop. A leaf in the toolbar says it's on. |
| Move tabs between windows | Drag a tab onto another window, or out of the strip for a new window; or tab menu → Move. |

### Windows

| Feature | How |
| --- | --- |
| New window | Ctrl+N. Shift+Enter in the address bar opens it there. |
| Profiles | Ctrl+Shift+M (Settings → Profiles): Kessels of their own -- history, bookmarks, passwords, settings, cookies, extensions, search engines, downloads folder. Open one, make one, or put a shortcut that opens it on your desktop. |
| Private window | Ctrl+Shift+N. No history, no saved session, cookies forgotten. |
| Close window | Ctrl+Shift+W or Alt+F4. Reopen with Ctrl+Shift+T. |
| Full screen | F11. |
| Pop-out window | Drag a tab below the toolbar, or tab menu → Pop out. |
| Compact or touch | Settings → Appearance → Density: Compact fits more page on the screen; Touch makes tabs, buttons and menus big enough for a finger. Any style. |
| Your own toolbar | Settings → Appearance → Toolbar buttons: hide the buttons you don't use, and move the others where you want them. |
| Name a window | Palette → Name window…: the name shows in its tab bar and on the taskbar, and comes back with the session. Click it to rename. |
| Saved sessions | Palette → Save all windows (or this window) as a session, or History → Saved sessions. Open one again whenever you like -- or every time Kessel starts (Settings → Search & Startup). |
| Split view | Tab menu → Open side by side with this tab, or drag a tab to the page's edge: two tabs in one window. Drag the divider to resize; swap or close from its buttons. |
| Workspaces | The buttons at the top of the rail (or Side panel → Workspaces): separate sets of tabs in one window, each with a name, icon and colour. The others' tabs sleep until you come back; the tab menu moves tabs between them. |

### Address bar

| Feature | How |
| --- | --- |
| Go / search | Ctrl+L, F6 or Alt+D, then type. Alt+Enter: new tab; Ctrl+Enter adds www. and .com. |
| Suggestions | Appear as you type: history, bookmarks, open tabs, your search engine. |
| Instant answers | Type 3*7, 5 km in miles, 20 usd in eur, define word, time in tokyo, uuid, password... |
| Commands | Type an action like clear history, private window, vertical tabs. |
| Search engine | Click the arrow in the address bar, or Settings → Search & Startup. |
| Share / QR code | The share button in the address bar. |
| Bookmark | Ctrl+D or the star: name it, pick a folder, add tags and a note. Ctrl+Shift+D bookmarks all tabs; Ctrl+Shift+B toggles the bar. |
| Bookmark manager | Ctrl+Shift+O: folders inside folders, drag to move, sort, search (#tag for a tag), cards with page previews, HTML import / export, duplicates, broken links, daily backups. |

### Pages

| Feature | How |
| --- | --- |
| Back / forward / reload | Alt+Left / Alt+Right, F5 or Ctrl+R; Ctrl+F5 ignores the cache; Esc stops. Right-click Back or Forward for the tab's own history. |
| When a site can't be reached | Kessel's page says why, tries again by itself once you're back online, and offers the copy your reading list kept. |
| Zoom | Ctrl+Plus / Ctrl+Minus / Ctrl+0, or Ctrl+mouse wheel. Remembered per site. |
| Find in page | Ctrl+F (starts with selected text), F3 / Shift+F3 for next / previous. |
| Print / save / source | Ctrl+P, Ctrl+S, Ctrl+U. |
| Developer tools | F12. Task manager: Shift+Esc. |
| Open a file | Ctrl+O. |
| Links | Ctrl+click or middle-click: new tab. Shift+click: new window. |
| Media controls | The music note beside the menu, once a tab has played sound: play/pause, seek, speed, captions, audio track, picture-in-picture -- for any tab of the window. |

### Page tools

| Feature | How |
| --- | --- |
| Command palette | F2: every command, searchable. Enter runs it; the ones you used lately come first. |
| Screenshots | Ctrl+Shift+S for what's in view; the palette has the whole page. Save, copy or both, PNG or JPEG: Settings → Page tools. |
| Reader view | F9 shows the article on its own. Aa: font, size, width, line height, colours, pictures. Read aloud with your choice of voice and speed. |
| Hide an element | Palette → Hide an element, then click it: hidden on that site from now on. Bring it back in Settings → Page tools. |
| Your style for a site | Palette → Change this site: your own CSS, a colour filter (dark, sepia, grayscale...) and auto-reload, per site. |
| Auto-reload | Palette → Auto-reload this site: every 15 s to 30 min (your own intervals in Settings → Page tools). |
| Mouse gestures | Hold the right button and draw: <- back, → forward, up-down reload, down-right close... Change or add them in Settings → Page tools. |
| Open links from the keyboard | Palette → Open a link with the keyboard: type the letters on a link; Shift opens it in a new tab. |
| Skip AMP pages | AMP copies of pages go to the real page. Settings → Page tools. |
| Copy a clean link | Palette → Copy link without tracking: no utm_, fbclid and the like. |
| Mute background tabs | Settings → Tabs: only the tab you're on plays sound. |
| Screenshot of a part | Palette → Screenshot of a part of the page, then drag a box. |
| Save as PDF | Palette → Save as PDF. Landscape, backgrounds, headers: Settings → Page tools. |
| Pause everything | Palette → Pause everything: every video stops and every tab goes quiet; again to carry on. |
| Peek at a link | Right-click a link → Peek at link: a small window over the page; “Back to tabs” keeps it. |
| Search for selected text or an image | Right-click → Search the web for… (Google Lens, Bing, Yandex or TinEye for images: Settings → Page tools). |
| Right-click menu | On a link: open it in a new tab, window or private window, copy its text. On an image: open it in a new tab. On text: translate, define, read aloud, share. On the page: translate it, take a screenshot. Which ones: Settings → Page tools. |
| Translate | A page in another language gets a Translate chip by the address (always or never for a language, never for a site). Or right-click selected text or the page → Translate. Which language and service: Settings → Page tools. |
| Theater mode | Palette → Theater mode: the page's video fills the tab, on black; Esc puts it back. |
| Command chains | Settings → Page tools → Command chains: several commands in one go, from the palette or a mouse gesture. |
| Missing pages | A page that's gone (404) offers its Wayback Machine copy; the palette's “Open in the Wayback Machine” works on any page. |
| Close forgotten tabs | Settings → Tabs: tabs you haven't looked at in days close by themselves. |
| Forget sites | Settings → Privacy: sites whose cookies and data go when you close their last tab. |
| Highlights and notes | Select text, Ctrl+Shift+H (or right-click → Highlight). Click a highlight for its colour, a note, or to remove it; they come back when you return. All of them: Settings → Page tools. |
| Screenshot editor | Settings → Page tools → When you take one → Open it in the editor: pen, highlighter, arrows, boxes, text, blur, crop, undo; then save or copy. |
| Feeds | Palette → Follow this site's feed, or add a site on the feeds page (palette → Feeds). Kessel fetches them itself; OPML import and export. |
| Watch a page for changes | Palette → Watch this page for changes: Kessel checks it every hour (or as often as you pick on the feeds page) and says in the toolbar when its text changed, with what's new. |
| Site permissions | Camera, microphone, location, notifications and more: Kessel asks under the address bar; answers per site and defaults in Settings → Site permissions. |
| Site settings | The lock in the address bar: JavaScript, images, pop-ups, redirects, sound, other sites' content and full screen, on or off for the site. Blocked pop-ups and redirects show a chip you can open them from. |
| Spelling and grammar | Misspelled words in what you type get a red underline, from Windows' own dictionaries (nothing leaves the PC): right-click for suggestions, Add to dictionary or Ignore. Grammar checking with LanguageTool, and the language: Settings → Page tools. |
| PDFs | PDFs open in Kessel's own viewer: thumbnails, search, highlight, draw, add text and pictures, fill in forms, sign, present full screen -- saved in the PDF. Or the engine's viewer: Settings → Page tools. |
| Install a site as an app | Menu → Install as app (or the address bar's button on a site that offers it): a Start menu entry and a window of its own, with its badge, jump list and file types. Settings → Apps lists them. |
| Notifications | Sites' notifications are Kessel's own cards in the corner of the screen, stacked per site; click one to go to its tab. The last 200, and Block per site: Settings → Site permissions → Notifications. |
| Download manager | Downloads: progress, pause, resume, cancel, try again, show in folder, search and sort. Folder, “ask where to save” and sorting into folders by kind: Settings → Downloads. |

### Search

| Feature | How |
| --- | --- |
| Search keywords | Type a keyword and a space: “yt cats” searches YouTube, “w Budapest” Wikipedia. Keywords and your own engines: Settings → Search & Startup. |
| Your own search engines | Settings → Search & Startup → Add a search engine; %s stands for what you searched. Any of them can be the default -- and private windows can have their own. |
| Paste and go | Palette → Paste and go: opens or searches what's on the clipboard. |
| Startup pages | Settings → Search & Startup → Pages to start with. |
| Sites' own search | Sites that offer their own search (OpenSearch) show up in Settings → Search & Startup, to add in a click. |

### Network and backup

| Feature | How |
| --- | --- |
| VPN | The VPN button: Kessel runs WireGuard itself -- import any provider's configs, or enter your Surfshark key for every Surfshark location -- or a SOCKS5/HTTP server. Only Kessel's traffic goes through it, with no DNS leaks; if the server is down nothing goes around it. Settings → Network. |
| Secure DNS | Settings → Network → Secure DNS: Cloudflare, Google, Quad9 or your own DNS-over-HTTPS / DNS-over-TLS server. “Only secure DNS” never falls back to your network's. |
| Proxy | Settings → Network: no proxy, your own (HTTP or SOCKS), or a PAC script; after a restart. Sites through a proxy of their own, or straight past the VPN: Sites through a proxy. |
| Engine switches | Settings → Network: your own Chromium command-line switches, for experiments. |
| Back up settings | Settings → About → Save to a file / Restore. |

### Passwords

| Feature | How |
| --- | --- |
| Save passwords as you sign in | After you sign in, Kessel asks whether to save the password (or update the saved one). “Never for this site” remembers; turn the offer off in Passwords → settings. |
| Password health | Passwords page: Weak and Reused show the passwords to change; “Check for breaches” looks them up in Have I Been Pwned (only 5 characters of each hash leave your computer). |
| Export passwords | Passwords → settings → Export: a CSV file other browsers import, after you type your master password. |
| Addresses and cards | Settings → Addresses & cards: click a form's field and pick one from Kessel's list under it (the page never sees the list); after you send a form with a new one, the toolbar offers to save it. Cards are encrypted for your Windows account; security codes are never kept. |

### Your data

| Feature | How |
| --- | --- |
| History | Ctrl+H. Search, by site, delete days or sites -- and by the words on pages, once Settings → History lets it remember them. |
| Downloads | Ctrl+J, or the rail's download button. |
| Read offline | Put a page on the reading list while it's open: a whole copy is kept, and opens when you're offline. |
| Passwords | Ctrl+Shift+L or the rail's key. Autofill offers saved logins. |
| Clear browsing data | Ctrl+Shift+Delete. |
| Privacy dashboard | Palette → Privacy dashboard (or Settings → Privacy): what Shields blocked and cleaned, day by day and per site; your protections; what sites may use; what Kessel connects to by itself -- no telemetry. |
| Accounts | The person button in the address bar: be signed in as several people at once. |
| Import | Settings → Import, from Chrome, Edge, Brave, Opera, Opera GX, Vivaldi and Firefox: bookmarks (with their folders), Speed Dial, history, the tabs that were open (as saved groups), cookies, passwords and Web Store extensions. |
| Export | History as a CSV file (Settings → History), the open tabs as a bookmarks file (Settings → Tabs), bookmarks (the bookmark manager), passwords (Passwords → settings) and settings (Settings → About). |

### Kessel

| Feature | How |
| --- | --- |
| Menu | Alt+F, F10 or the dots at the top right. |
| Shields (ad blocking) | The shield in the address bar or on the rail. Settings → Privacy: which filter lists, and your own by its address. |
| Sidebar sites | Tab menu → Add to sidebar, or the + on the rail. |
| Side panel | The rail's buttons: Bookmarks, History, Reading list, Notes, Search (tabs, bookmarks, notes and history at once) and Extensions, beside the page. |
| AI assistant | ChatGPT, Claude, Gemini, Copilot, Perplexity, Le Chat or your own in the side panel (Settings → Side panel). Right-click a page or selected text → Ask AI about this. |
| Extensions | On an extension's page in the Chrome Web Store or Edge Add-ons: Add to Kessel in the address bar. What it may do is shown first; updates come by themselves. Settings → Extensions: turn on or off, site access, remove, developer mode. |
| Your own shortcuts | Settings → Keyboard & Mouse. |
| Look | Settings → Appearance: theme, Liquid Glass, wallpaper, bookmarks bar. |
| Help | F1: shortcuts and tips. |
| Hardware acceleration | Settings → Performance: on or off, and which graphics card. kessel://gpu shows what the graphics card does and which video formats play. |
| Task manager | Shift+Esc: every process with its memory and CPU -- each page's with its tabs, the graphics card's, the network's -- and the tabs asleep. End a process, put a tab to sleep, wake one. |
| Diagnostics | Palette → Diagnostics (kessel://diagnostics): Windows, the processor, memory, network, how much room your data takes, crash reports and which web features work; Copy report. |
| When something crashes | A crashed page offers Reload; one in the background loads again when you come back. If the engine goes, Kessel starts again with your tabs; if Kessel itself closed unexpectedly, a chip offers your tabs back. |
| Accessibility | Settings → Accessibility: bigger text (only the text), a smallest font size, your fonts, less motion, a bold keyboard outline, caret browsing (F7), colour filters, subtitles you can read. Shift+F6 takes the keyboard back to the page. |
| Lock Kessel | Settings → Security → Lock Kessel: a PIN or password (or Windows Hello) before your tabs show again. Lock from the menu, when Kessel starts, or after the PC's left alone; private windows only if you like. |
| Safe mode | Palette → Restart in safe mode (or kessel.exe --safe-mode): no extensions, no graphics card. Kessel starts that way by itself if it failed to start twice in a row. |

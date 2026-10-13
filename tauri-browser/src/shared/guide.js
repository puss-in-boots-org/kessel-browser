// The guide: a tour of what Kessel can do, by topic, and where to find it.
// Shown in Help (kessel://help, F1) and written out, together with every
// feature from features.js, as docs/GUIDE.md by scripts/build-guide.mjs --
// one text for both, so they never disagree.
//
// Each tip is [title, body]. Bodies are a little HTML: <kbd> for keys,
// <code> for things you type, <b>, and <a data-open="kessel://..."> for
// Kessel's own pages (Help opens them in a tab; the Markdown keeps the text).

export const GUIDE = [
  {
    id: "start",
    label: "Getting started",
    icon: "sparkle",
    intro: "Kessel is a light, fast browser for Windows with Shields, a password vault, a VPN, workspaces and a side panel built in. These are the first things worth knowing.",
    tips: [
      ["Bring your things along", `Bookmarks, history, passwords, open tabs, cookies and extensions come straight from Chrome, Edge, Brave, Opera, Opera GX, Vivaldi or Firefox. <a data-open="kessel://settings/import">Settings → Import</a>`],
      ["Make it your default browser", `<a data-open="kessel://settings/search">Settings → Search &amp; Startup → Default browser</a> registers Kessel and opens Windows' Default apps page at it.`],
      ["Every command in one place", "Press <kbd>F2</kbd> for the command palette: every command Kessel has, searchable, recent ones first. Most of this guide is a few letters away there."],
      ["Ask the address bar", "Besides addresses and searches it answers sums (<code>15% of 80</code>), conversions (<code>10 km to miles</code>, <code>100 usd to eur</code>), definitions (<code>define serendipity</code>) and the time anywhere -- and runs commands by name (<code>clear cache</code>)."],
      ["Keep your tabs", `Turn on "Keep tabs when Kessel closes" and your windows, tabs, groups and workspaces come back next time. <a data-open="kessel://settings/tabs">Settings → Tabs</a>`],
      ["Your keys, your way", `Every shortcut can be changed, and mouse gestures (hold the right button and draw) run commands too. <a data-open="kessel://settings/shortcuts">Settings → Keyboard &amp; Mouse</a>`],
      ["Everything else", `Settings → All features lists every feature with how to use it. <a data-open="kessel://settings/features">Open it</a>`],
    ],
  },
  {
    id: "shields",
    label: "Shields & privacy",
    icon: "shield",
    intro: "Kessel blocks ads and trackers on every site by itself, and sends no telemetry.",
    tips: [
      ["Shields", "Blocks ads, trackers, cryptominers and malicious sites, upgrades connections to HTTPS, strips tracking codes from links and skips click-tracking redirect pages. The shield in the address bar shows what it blocked and turns it off for one site."],
      ["Fingerprinting", "Shields gives sites slightly different answers about your canvas, audio, graphics card, processor and screen, so they can't recognise you by your PC."],
      ["More filter lists", `Cookie notices and other annoyances have optional lists, and you can add any filter list by its address. <a data-open="kessel://settings/privacy">Settings → Privacy</a>`],
      ["Hide something for good", "Command palette → <b>Hide an element</b>, then click what you never want to see on that site again. Undo it in Settings → Page tools."],
      ["Cookies", `Third-party cookies are blocked by default. Per site, cookies can be allowed, kept until Kessel closes, or blocked; every cookie can be looked at and edited. <a data-open="kessel://settings/cookies">Settings → Cookies &amp; site data</a>`],
      ["Forget a site", "Settings → Privacy → <b>Forget these sites when you close them</b>: a site's cookies and storage go when its last tab closes."],
      ["Private windows", "<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd>: a fresh identity -- no history, cookies or sign-ins kept once the last private window closes."],
      ["Privacy dashboard", `What Shields blocked day by day and per site, your protections, what sites may use, and every connection Kessel makes by itself. <a data-open="kessel://privacy">kessel://privacy</a>`],
      ["Clear browsing data", `<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Del</kbd>: history, cookies, cache and more, for the last hour or any time -- or by itself whenever Kessel closes. <a data-open="kessel://settings/clear">Open it</a>`],
    ],
  },
  {
    id: "safety",
    label: "Safety & passwords",
    icon: "lock",
    intro: "Passwords, cards and the lock screen, and how Kessel keeps you off dangerous sites.",
    tips: [
      ["The password vault", `Encrypted with your master password. After you sign in somewhere Kessel offers to save the password; on that site's sign-in page a chip under the field fills it in when you click it. <a data-open="kessel://passwords">kessel://passwords</a> (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd>)`],
      ["Password checks", "The Passwords page flags weak and reused passwords, and -- only when you ask -- breached ones: just 5 characters of each password's SHA-1 hash ever leave the computer."],
      ["Addresses & cards", `Filled in from a list under the field that only you see; cards are encrypted for your Windows account, and their security code is never kept. <a data-open="kessel://settings/autofill">Settings → Addresses &amp; cards</a>`],
      ["Passkeys and security keys", "Sites that use passkeys or USB/NFC security keys work through Windows Hello, which keeps the passkeys."],
      ["Lock Kessel", `A PIN, a password or Windows Hello locks every window: when Kessel starts, after you've been away a while, or just your private windows. <a data-open="kessel://settings/security">Settings → Security</a>`],
      ["Dangerous sites and downloads", "Malware, phishing and badware lists are checked on this PC -- nothing is sent anywhere -- and turn into a warning page. Risky downloads wait for you to keep or discard them."],
      ["HTTPS-only", "Settings → Security: every site opened over https, with a warning before one that has none. Plain http sites always show a red \"Not secure\"."],
      ["Site info", "Click the lock in the address bar: the connection, the certificate, the site's cookies and data, and its permissions."],
    ],
  },
  {
    id: "network",
    label: "VPN & network",
    icon: "globe",
    intro: "A VPN, secure DNS and proxies built into Kessel -- for Kessel's own traffic, nothing else on the PC.",
    tips: [
      ["The VPN button", `Kessel runs WireGuard itself: import any provider's WireGuard configs, or enter your Surfshark key for every Surfshark location. SOCKS5 and HTTP servers work too. It turns on and off at once, without DNS leaks, and nothing goes around it when the server is down. <a data-open="kessel://settings/network">Settings → Network</a>`],
      ["Secure DNS", "DNS over HTTPS or TLS: Cloudflare, Google, Quad9 or your own server. \"Only secure DNS\" never falls back to your network's."],
      ["Proxies", "No proxy, Windows' setting, your own HTTP or SOCKS5 server, or a PAC script -- and single sites through a proxy of their own, or straight past the VPN."],
      ["Several accounts side by side", "Accounts give tabs their own cookie jars: be signed in to the same site as several people at once, each account's tabs in its colour. Use the person button in the address bar."],
      ["Profiles", `A completely separate Kessel -- its own history, passwords, settings, extensions and network -- with a desktop shortcut of its own. <a data-open="kessel://settings/profiles">Settings → Profiles</a> (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd>)`],
    ],
  },
  {
    id: "workspaces",
    label: "Side panel & workspaces",
    icon: "sidebar",
    intro: "The rail at the side of the window holds your workspaces, panels and pinned sites.",
    tips: [
      ["Workspaces", "Separate sets of tabs in one window -- work, study, games. The buttons at the top of the rail switch between them; the others' tabs sleep until you come back, and each workspace tints the window in its colour."],
      ["The side panel", "Bookmarks, History, the Reading list, Notes, Search and Extensions, beside the page you're reading. Drag its edge to resize it."],
      ["Pinned sites", `Any site -- chat, music, mail -- can live in the side panel. <a data-open="kessel://settings/pinned">Settings → Pinned Sites</a>`],
      ["An AI assistant", `ChatGPT, Claude, Gemini, Copilot, Perplexity, Le Chat or your own, in the side panel. Right-click a page or selected text → <b>Ask AI about this</b>. <a data-open="kessel://settings/sidebar">Settings → Side panel</a>`],
      ["Notes", "Side panel → Notes: saved as you type, pinned, linked to the page you were on. Right-click selected text → <b>Save selection to notes</b>."],
      ["Search everything", "Side panel → Search looks through open tabs, bookmarks, the reading list, notes and history at once."],
    ],
  },
  {
    id: "reading",
    label: "Reading & research",
    icon: "book",
    intro: "Tools for reading, keeping and understanding what's on the web.",
    tips: [
      ["Reader view", "<kbd>F9</kbd>: just the article, nothing of the site running, with minutes to read -- and <b>Read aloud</b>, paragraph by paragraph."],
      ["Reading list", "Right-click a page or a link → <b>Add to reading list</b>. A page saved while it's open is kept whole, to read offline."],
      ["Highlights and notes", "Select text and press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>: it's highlighted again whenever you come back. Click a highlight to add a note."],
      ["Spelling and grammar", `Misspelled words get a red underline, from Windows' own dictionaries (nothing leaves the PC); right-click for suggestions. Grammar checking (LanguageTool) can be turned on. <a data-open="kessel://settings/tools">Settings → Page tools</a>`],
      ["Translate", "A Translate chip appears on pages in another language: translate once, always for that language, or never. Right-click selected text → <b>Translate</b>, or a word → <b>Define</b>."],
      ["PDFs", "Kessel's own PDF viewer: thumbnails, search, highlight, draw, add text and pictures, fill in forms, sign, and present full screen. What you add is saved in the PDF."],
      ["Feeds and watched pages", `Follow a site's RSS or Atom feed, or have Kessel watch any page and tell you when its text changes. <a data-open="kessel://feeds">kessel://feeds</a>`],
      ["Peek at a link", "Right-click a link → <b>Peek at link</b> opens it in a small floating window, without leaving your page."],
      ["Find pages by what they said", "Settings → History → <b>Remember what pages say</b> (off by default): History then finds pages by any words on them."],
    ],
  },
  {
    id: "media",
    label: "Media & capture",
    icon: "music",
    intro: "Control sound and video in any tab, and capture what's on screen.",
    tips: [
      ["Media controls", "The music-note button beside the menu shows every tab playing sound: play, pause, skip, seek, speed, captions and audio tracks -- without switching tabs."],
      ["Picture-in-picture", "<kbd>Alt</kbd>+<kbd>P</kbd> floats the tab's video in its own always-on-top window. Command palette → <b>Theater mode</b> fills the tab with it instead."],
      ["Only one tab plays", "Settings → Tabs → <b>Only the tab you're on plays sound</b> mutes the rest. Command palette → <b>Pause everything</b> stops every page and sound at once."],
      ["Subtitles your way", "Settings → Accessibility → Subtitles: captions bigger, in another colour, on another background, on every site."],
      ["Screenshots", "<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> takes what's in view; the command palette takes the whole page or a part you drag. The editor has a pen, highlighter, arrows, boxes, text, blur and crop."],
      ["Share", "The share button in the address bar copies the link (also as Markdown) or a QR code, or opens Windows' Share window."],
    ],
  },
  {
    id: "apps",
    label: "Apps & downloads",
    icon: "grid",
    intro: "Install sites as apps, add extensions and keep track of what you download.",
    tips: [
      ["Install a site as an app", `Menu → <b>Install as app</b>: a Start menu entry and a window of its own, with its badge, jump list and file types. <a data-open="kessel://settings/apps">Settings → Apps</a>`],
      ["Extensions", `On an extension's page in the Chrome Web Store or Edge Add-ons, click <b>Add to Kessel</b> in the address bar. Kessel shows what it may do first, and keeps it up to date. <a data-open="kessel://settings/extensions">Settings → Extensions</a>`],
      ["Downloads", `<kbd>Ctrl</kbd>+<kbd>J</kbd>: pause, resume, retry, search and sort. Kessel can ask where to save each file, or sort downloads into Pictures, Videos, Documents and more. <a data-open="kessel://settings/downloads">Settings → Downloads</a>`],
      ["Notifications", `Sites' notifications are Kessel's own cards, stacked per site, with a history. Allow or block them per site. <a data-open="kessel://settings/permissions">Settings → Site permissions</a>`],
    ],
  },
  {
    id: "look",
    label: "Look & feel",
    icon: "palette",
    intro: "Make Kessel look and feel the way you want.",
    tips: [
      ["Styles and colours", `Pick a style and its colours, a wallpaper, light or dark (or follow Windows). Chrome themes' colours work too. <a data-open="kessel://settings/appearance">Settings → Appearance</a>`],
      ["Tabs on the side", "Settings → Tabs → Tab layout: <b>Side</b> puts the tabs in a column beside the page, resizable and collapsible to icons."],
      ["Compact or touch", "Settings → Appearance → Density: Compact for more page, Touch for bigger targets. The toolbar's buttons can be hidden and moved."],
      ["Split view", "Right-click a tab → <b>Open side by side with this tab</b>, or drag a tab to the page's edge: two tabs in one window."],
      ["Make a site yours", "Command palette → <b>Change this site</b>: your own CSS for it. Colour filters (dark, sepia, grayscale, more contrast…) work per site or everywhere."],
      ["Easier to read", `Text size, the smallest font size, your own fonts, less motion and a bold keyboard outline. <a data-open="kessel://settings/accessibility">Settings → Accessibility</a>`],
    ],
  },
  {
    id: "speed",
    label: "Speed & battery",
    icon: "bolt",
    intro: "Kessel keeps itself light without you having to think about it.",
    tips: [
      ["Sleeping tabs", `Background tabs are slowed, then paused, then put to sleep to free memory, and wake up when you come back. Tabs playing sound and sites you list are left alone. <a data-open="kessel://settings/performance">Settings → Performance</a>`],
      ["Energy saver", "On battery (or always), background tabs pause sooner and Kessel's own animations stop. A leaf in the toolbar says it's on."],
      ["What's using memory", "Rest the mouse on a tab to see its memory and CPU. <kbd>Shift</kbd>+<kbd>Esc</kbd> opens the task manager: every process, with buttons to end it or put its tabs to sleep."],
      ["Forgotten tabs", "Settings → Tabs → <b>Close tabs you've forgotten</b> tidies up tabs you haven't touched in days."],
      ["When something goes wrong", "A crashed tab says so and reloads in a click; if the engine stops, Kessel comes back with your tabs. Safe mode (<code>kessel.exe --safe-mode</code>) starts without extensions or the graphics card."],
      ["Look under the hood", `<a data-open="kessel://diagnostics">kessel://diagnostics</a> (this PC, network, storage, crash reports) and <a data-open="kessel://gpu">kessel://gpu</a> (graphics and video formats), each with a report to copy.`],
    ],
  },
];

// A body's plain text: for searching, and for the Markdown.
export function plainText(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

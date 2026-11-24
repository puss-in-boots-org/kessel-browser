// The Kessel Store's catalog (store.html): extensions picked for Kessel,
// each a Chrome Web Store package (its id) that Kessel downloads and runs
// with its own runtime. `fit` says how well it runs in Kessel:
//   "good"    -- what it does fits what Kessel's runtime covers today
//   "limited" -- runs, but leans on something Kessel doesn't do yet (said
//                in `note`)
// Nobody has checked these in a real Kessel on Windows yet: an entry moves
// to "checked: true" once someone has.
//
// `match`: words the package's own name must contain -- if the store sends
// something else for that id, Kessel won't add it.

export const CATEGORIES = [
  { id: "all", label: "Featured" },
  { id: "privacy", label: "Ad blocking & privacy" },
  { id: "passwords", label: "Passwords" },
  { id: "video", label: "Video" },
  { id: "look", label: "Appearance" },
  { id: "writing", label: "Writing & language" },
  { id: "productivity", label: "Productivity" },
  { id: "developer", label: "Developer" },
];

export const CATALOG = [
  { id: "ddkjiahejlhfcafbddmgiahcphecmpfh", name: "uBlock Origin Lite", match: "ublock", category: "privacy", featured: true, fit: "good", blurb: "A light, fast content blocker. Its filter rules go straight into Kessel's own request filter." },
  { id: "pkehgijcmpdhfbdbbnkijodmdjhbjlgp", name: "Privacy Badger", match: "privacy badger", category: "privacy", fit: "limited", blurb: "Learns which trackers follow you around and stops them.", note: "Learning new trackers watches requests (webRequest), which Kessel doesn't hand to extensions yet." },
  { id: "mdjildafknihdffpkfmmpnpoiajfjnjd", name: "Consent-O-Matic", match: "consent", category: "privacy", featured: true, fit: "good", blurb: "Answers cookie pop-ups for you, the way you choose." },
  { id: "edibdbjcniadpccecjdfdjjppcpchdlm", name: "I still don't care about cookies", match: "cookies", category: "privacy", fit: "good", blurb: "Gets rid of cookie warnings on most sites." },
  { id: "lckanjgmijmafbedllaakclkaicjfmnk", name: "ClearURLs", match: "clearurls", category: "privacy", fit: "good", blurb: "Strips tracking parts from the addresses you visit." },
  { id: "nngceckbapebfimnlniiiahkandclblb", name: "Bitwarden", match: "bitwarden", category: "passwords", featured: true, fit: "limited", blurb: "Open-source password manager, synced across your devices.", note: "Filling from the right-click menu needs context menus, coming next." },
  { id: "ghmbeldphafepmbegfdlkpapadhbakde", name: "Proton Pass", match: "proton", category: "passwords", fit: "limited", blurb: "End-to-end encrypted passwords and email aliases from Proton.", note: "Some parts use offscreen documents, which Kessel doesn't run yet." },
  { id: "aeblfdkhhhdcdjpifhhbdiojplfjncoa", name: "1Password", match: "1password", category: "passwords", fit: "limited", blurb: "1Password in your browser.", note: "Talking to the 1Password app uses native messaging, which Kessel doesn't do yet." },
  { id: "mnjggcdmjocbbbhaepdhchncahnbgone", name: "SponsorBlock", match: "sponsorblock", category: "video", featured: true, fit: "good", blurb: "Skips sponsor segments in YouTube videos, marked by the community." },
  { id: "gebbhagfogifgggkldgodflihgfeippi", name: "Return YouTube Dislike", match: "dislike", category: "video", fit: "good", blurb: "Brings back the dislike count on YouTube." },
  { id: "khncfooichmfjbepaaaebmommgaepoid", name: "Unhook", match: "unhook", category: "video", fit: "good", blurb: "Hides YouTube's recommendations, Shorts and comments -- whichever you like." },
  { id: "nffaoalbilbmmfgbnbgppjihopabppdk", name: "Video Speed Controller", match: "speed", category: "video", fit: "good", blurb: "Speed up, slow down and skip in any HTML5 video with the keyboard." },
  { id: "ponfpcnoihfmfllpaingbgckeeldkhle", name: "Enhancer for YouTube", match: "youtube", category: "video", fit: "good", blurb: "Volume by mouse wheel, cinema mode, playback speed and more for YouTube." },
  { id: "eimadpbcbfnmbkopoojfekhnkhdbieeh", name: "Dark Reader", match: "dark reader", category: "look", featured: true, fit: "good", blurb: "Dark mode for every website, with brightness and contrast to taste." },
  { id: "clngdbkpkpeebahjckkjfobafhncgmne", name: "Stylus", match: "stylus", category: "look", fit: "good", blurb: "Restyle any site with your own CSS, or with themes from userstyles.world." },
  { id: "aapbdbdomjkkjkaonfhkkikfgjllcleb", name: "Google Translate", match: "translate", category: "writing", fit: "limited", blurb: "Translate words and pages as you read.", note: "Translating from the right-click menu needs context menus, coming next." },
  { id: "kbfnbcaeplbcioakkpcpgfkobkghlhen", name: "Grammarly", match: "grammarly", category: "writing", fit: "limited", blurb: "Spelling, grammar and tone suggestions as you write.", note: "A big extension that uses many Chrome features -- expect rough edges." },
  { id: "jldhpllghnbhlbpcmnajkpdmadaolakh", name: "Todoist", match: "todoist", category: "productivity", fit: "good", blurb: "Your to-do list one click away; turn pages into tasks." },
  { id: "laookkfknpbbblfpciffpaejjkokdgca", name: "Momentum", match: "momentum", category: "productivity", fit: "limited", blurb: "A calm dashboard with your focus and to-dos.", note: "It replaces the new tab page, which Kessel keeps for its own for now." },
  { id: "dhdgffkkebhmkfjojejmpbldmpobfkfo", name: "Tampermonkey", match: "tampermonkey", category: "developer", fit: "limited", blurb: "Run user scripts on the sites you choose.", note: "Recent versions register scripts with chrome.userScripts, which Kessel doesn't have yet." },
  { id: "bcjindcccaagfpapjjmafapmmgkkhgoa", name: "JSON Formatter", match: "json", category: "developer", fit: "good", blurb: "Makes JSON readable, with folding and highlighting." },
  { id: "gppongmhjkpfnbhagpmjfkannfbllamg", name: "Wappalyzer", match: "wappalyzer", category: "developer", fit: "limited", blurb: "Shows what a website is built with.", note: "Some detections watch requests (webRequest), which Kessel doesn't hand to extensions yet." },
  { id: "bhlhnicpbhignbdhedgjhgdocnmhomnp", name: "ColorZilla", match: "colorzilla", category: "developer", fit: "good", blurb: "Eyedropper, colour picker and gradient generator." },
];

// A Chrome Web Store link (or a bare id) -> the extension's id.
export function storeIdOf(text) {
  const t = String(text || "").trim();
  if (/^[a-p]{32}$/.test(t)) return t;
  const m = /(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore)\/detail\/(?:[^/?#]+\/)?([a-p]{32})/i.exec(t);
  return m ? m[1].toLowerCase() : null;
}

// Whether a package's name is the catalog entry's.
export function nameFits(entry, name) {
  return String(name || "").toLowerCase().includes(entry.match);
}

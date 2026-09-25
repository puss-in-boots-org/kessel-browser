// A compact set of inline SVG line icons, all using currentColor so they
// automatically follow the active theme with zero extra CSS. Kept as plain
// template strings (no icon font / no network fetch) so the whole UI stays
// usable fully offline and paints instantly.

const PATHS = {
  back: '<path d="M15 5 8 12l7 7"/>',
  forward: '<path d="M9 5l7 7-7 7"/>',
  reload: '<path d="M3 11a9 9 0 1 1 2.6 6.4"/><path d="M3 4v6h6"/>',
  home: '<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9h12v-9"/><path d="M10 19v-5h4v5"/>',
  star: '<path d="M12 3.5l2.6 5.4 5.9.7-4.3 4.1 1 5.9L12 16.8 6.8 19.6l1-5.9-4.3-4.1 5.9-.7z"/>',
  starFilled: '<path fill="currentColor" stroke="none" d="M12 3.5l2.6 5.4 5.9.7-4.3 4.1 1 5.9L12 16.8 6.8 19.6l1-5.9-4.3-4.1 5.9-.7z"/>',
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>',
  shieldCheck: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  shieldOff: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 9l6 6M15 9l-6 6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/>',
  download: '<path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/>',
  pin: '<path d="M12 2v6"/><path d="M8 8h8l1.5 5H6.5z"/><path d="M12 13v9"/>',
  pinFilled: '<path fill="currentColor" stroke="none" d="M13 2h-2v6.2L8 9.3 6.5 14h11L16 9.3l-3-1.1zM11 13h2v9h-2z"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.4-2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.5 12.5 20 3"/><path d="M16 7l2.5 2.5"/><path d="M13 10l2 2"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c.8-3.6 3.8-5.6 7.5-5.6s6.7 2 7.5 5.6"/>',
  userPlus: '<circle cx="10" cy="8.5" r="3.6"/><path d="M3.5 20c.7-3.5 3.3-5.5 6.5-5.5 1.3 0 2.5.3 3.5.9"/><path d="M18 14v6"/><path d="M15 17h6"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.2A10.6 10.6 0 0 1 12 5c6 0 10 7 10 7a15.6 15.6 0 0 1-3.4 4.1M6.6 6.6C4 8.3 2 12 2 12s4 7 10 7a9.8 9.8 0 0 0 4.4-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
  check: '<path d="M4 12l6 6L20 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>',
  palette: '<circle cx="12" cy="12" r="9"/><circle cx="8.5" cy="10.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="15.5" cy="10.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="10" cy="14.5" r="1.2" fill="currentColor" stroke="none"/><path d="M12 21a9 9 0 0 1 0-18 4 4 0 0 1 0 8h-.5a2 2 0 0 0 0 4H13a2 2 0 0 1 0 4z" fill="none"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v5l3 2"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z"/>',
  refresh: '<path d="M3 11a9 9 0 1 1 2.6 6.4"/><path d="M3 4v6h6"/>',
  bolt: '<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  qr: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3z"/><path d="M20 14v7"/><path d="M14 20h7"/>',
  warning: '<path d="M12 3 2 20h20z"/><path d="M12 10v4"/><circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none"/>',
  logo: '<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5"/><path d="M12 12v10"/>',
  x: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
  popOut: '<path d="M14 4h6v6"/><path d="M20 4l-8 8"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  winMin: '<path d="M6 12h12"/>',
  winMax: '<rect x="6" y="6" width="12" height="12" rx="2.5"/>',
  winRestore: '<rect x="5" y="8.5" width="10.5" height="10.5" rx="2.2"/><path d="M8.5 5.5h7.5A2.5 2.5 0 0 1 18.5 8v7.5"/>',
  arrowRight: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
  incognito: '<path d="M3 11h18"/><path d="M5.5 11l1.8-5.5h9.4l1.8 5.5"/><circle cx="7.5" cy="16" r="2.6"/><circle cx="16.5" cy="16" r="2.6"/><path d="M10.1 16h3.8"/>',
  window: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h18"/><circle cx="6.5" cy="6.5" r="0.6" fill="currentColor" stroke="none"/><circle cx="9" cy="6.5" r="0.6" fill="currentColor" stroke="none"/>',
  print: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
  save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3"/><rect x="8" y="13" width="8" height="6" rx="1"/>',
  find: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/><path d="M8.5 11h5"/>',
  expand: '<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/>',
  code: '<path d="M8 7l-5 5 5 5"/><path d="M16 7l5 5-5 5"/><path d="M13.5 4l-3 16"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><circle cx="12" cy="17.2" r="0.7" fill="currentColor" stroke="none"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>',
  minus: '<path d="M5 12h14"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  broom: '<path d="M14 4l6 6"/><path d="M12.5 5.5l6 6-3.5 3.5-6-6z"/><path d="M9 9l-5.5 5.5c-.8.8-.8 2.1 0 2.8l2.2 2.2c.8.8 2 .8 2.8 0L14 15"/>',
  activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 14h12"/>',
  dots: '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  dotsV: '<circle cx="12" cy="5" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none"/>',
  drag: '<circle cx="9" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.2" fill="currentColor" stroke="none"/>',
};

export function icon(name, size = 18) {
  const body = PATHS[name] || PATHS.globe;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function faviconLetter(urlOrTitle) {
  try {
    const host = new URL(urlOrTitle).hostname.replace(/^www\./, "");
    return (host[0] || "?").toUpperCase();
  } catch {
    return (urlOrTitle || "?").trim()[0]?.toUpperCase() || "?";
  }
}

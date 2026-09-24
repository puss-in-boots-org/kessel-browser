// Keyboard shortcuts. Every browser shortcut is handled here, in Rust, from
// WebView2's AcceleratorKeyPressed event on every Kessel webview -- tabs,
// the toolbar, the side panel, pop-outs. The event fires before the page
// sees the key, so shortcuts work on every website: pages can't swallow
// them, and they no longer depend on the page script reaching Kessel's IPC,
// which Tauri refuses to websites (the old in-page shortcuts silently did
// nothing there).
//
// A shortcut is written like "Ctrl+Shift+T", "Alt+Left", "F5" or
// "Ctrl+Plus". Matching is exact about modifiers, so AltGr (Ctrl+Alt on many
// European layouts, used to type @ [ ] { } and so on) never triggers a Ctrl
// shortcut. "Plus" and "Minus" match wherever the layout puts + and - (the
// = key, the numpad, Shift+3 on a Hungarian keyboard...), with or without
// Shift, like Chrome's zoom keys.

pub const CTRL: u8 = 1;
pub const SHIFT: u8 = 2;
pub const ALT: u8 = 4;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Key {
    Vk(u32),
    Plus,
    Minus,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Chord {
    pub mods: u8,
    pub key: Key,
}

const NAMED_KEYS: &[(&str, u32)] = &[
    ("Backspace", 0x08),
    ("Tab", 0x09),
    ("Enter", 0x0D),
    ("Pause", 0x13),
    ("Escape", 0x1B),
    ("Space", 0x20),
    ("PageUp", 0x21),
    ("PageDown", 0x22),
    ("End", 0x23),
    ("Home", 0x24),
    ("Left", 0x25),
    ("Up", 0x26),
    ("Right", 0x27),
    ("Down", 0x28),
    ("Insert", 0x2D),
    ("Delete", 0x2E),
    ("Num0", 0x60),
    ("Num1", 0x61),
    ("Num2", 0x62),
    ("Num3", 0x63),
    ("Num4", 0x64),
    ("Num5", 0x65),
    ("Num6", 0x66),
    ("Num7", 0x67),
    ("Num8", 0x68),
    ("Num9", 0x69),
    ("NumMultiply", 0x6A),
    ("NumDecimal", 0x6E),
    ("NumDivide", 0x6F),
    (";", 0xBA),
    ("=", 0xBB),
    (",", 0xBC),
    (".", 0xBE),
    ("/", 0xBF),
    ("`", 0xC0),
    ("[", 0xDB),
    ("\\", 0xDC),
    ("]", 0xDD),
    ("'", 0xDE),
    ("BrowserBack", 0xA6),
    ("BrowserForward", 0xA7),
    ("BrowserRefresh", 0xA8),
    ("BrowserStop", 0xA9),
    ("BrowserSearch", 0xAA),
    ("BrowserFavorites", 0xAB),
    ("BrowserHome", 0xAC),
];

const VK_ADD: u32 = 0x6B;
const VK_SUBTRACT: u32 = 0x6D;
const VK_OEM_PLUS: u32 = 0xBB;
const VK_OEM_MINUS: u32 = 0xBD;

fn key_from_name(name: &str) -> Option<Key> {
    let lower = name.to_ascii_lowercase();
    match lower.as_str() {
        "plus" | "+" => return Some(Key::Plus),
        "minus" | "-" => return Some(Key::Minus),
        "esc" => return Some(Key::Vk(0x1B)),
        "del" => return Some(Key::Vk(0x2E)),
        "pgup" => return Some(Key::Vk(0x21)),
        "pgdn" => return Some(Key::Vk(0x22)),
        "return" => return Some(Key::Vk(0x0D)),
        _ => {}
    }
    if let Some((_, vk)) = NAMED_KEYS.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)) {
        return Some(Key::Vk(*vk));
    }
    if name.len() == 1 {
        let c = name.chars().next()?.to_ascii_uppercase();
        if c.is_ascii_uppercase() || c.is_ascii_digit() {
            return Some(Key::Vk(c as u32));
        }
    }
    if let Some(n) = lower.strip_prefix('f').and_then(|n| n.parse::<u32>().ok()) {
        if (1..=24).contains(&n) {
            return Some(Key::Vk(0x6F + n));
        }
    }
    None
}

fn key_name(key: Key) -> String {
    match key {
        Key::Plus => "Plus".into(),
        Key::Minus => "Minus".into(),
        Key::Vk(vk) => {
            if let Some((name, _)) = NAMED_KEYS.iter().find(|(_, v)| *v == vk) {
                return (*name).to_string();
            }
            match vk {
                0x30..=0x39 | 0x41..=0x5A => char::from_u32(vk).map(|c| c.to_string()).unwrap_or_default(),
                0x70..=0x87 => format!("F{}", vk - 0x6F),
                _ => format!("Key{}", vk),
            }
        }
    }
}

pub fn parse_chord(text: &str) -> Option<Chord> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    // "Ctrl++" -> the key is "+".
    let (body, plus_key) = match text.strip_suffix("++") {
        Some(rest) => (rest, true),
        None => (text, false),
    };
    let mut mods = 0u8;
    let mut key = if plus_key { Some(Key::Plus) } else { None };
    for part in body.split('+').map(str::trim).filter(|p| !p.is_empty()) {
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => mods |= CTRL,
            "shift" => mods |= SHIFT,
            "alt" => mods |= ALT,
            _ => {
                if key.is_some() {
                    return None; // two non-modifier keys
                }
                key = Some(key_from_name(part)?);
            }
        }
    }
    Some(Chord { mods, key: key? })
}

pub fn format_chord(chord: &Chord) -> String {
    let mut parts: Vec<String> = Vec::new();
    if chord.mods & CTRL != 0 {
        parts.push("Ctrl".into());
    }
    if chord.mods & SHIFT != 0 {
        parts.push("Shift".into());
    }
    if chord.mods & ALT != 0 {
        parts.push("Alt".into());
    }
    parts.push(key_name(chord.key));
    parts.join("+")
}

// The chords a key press can match, most specific first: the key itself,
// then (for the + and - keys, wherever the layout has them) Plus / Minus
// without regard to Shift.
pub fn candidates(vk: u32, mods: u8, typed: Option<char>) -> Vec<Chord> {
    let mut out = vec![Chord { mods, key: Key::Vk(vk) }];
    let without_shift = mods & !SHIFT;
    if vk == VK_OEM_PLUS || vk == VK_ADD || typed == Some('+') {
        out.push(Chord { mods: without_shift, key: Key::Plus });
    }
    if vk == VK_OEM_MINUS || vk == VK_SUBTRACT || typed == Some('-') {
        out.push(Chord { mods: without_shift, key: Key::Minus });
    }
    out
}

// Which Kessel webview a key press came from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    // Kessel's own UI in the main window: the toolbar and its popups.
    Toolbar,
    Tab(u32),
    SidePanel,
    Popout(u32),
}

impl Source {
    pub fn from_label(label: &str) -> Source {
        if let Some(id) = label.strip_prefix("content-").and_then(|s| s.parse().ok()) {
            Source::Tab(id)
        } else if label == "side-panel" {
            Source::SidePanel
        } else if let Some(id) = label
            .strip_prefix("popout-content-")
            .or_else(|| label.strip_prefix("popout-bar-"))
            .and_then(|s| s.parse().ok())
        {
            Source::Popout(id)
        } else {
            Source::Toolbar
        }
    }
}

// The character a key types (with or without Shift) on the current keyboard
// layout -- how "Plus" finds + on layouts that don't have a + key.
#[cfg(windows)]
fn typed_char(vk: u32, shift: bool) -> Option<char> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyboardLayout, MapVirtualKeyExW, ToUnicodeEx, MAPVK_VK_TO_VSC_EX};
    unsafe {
        let layout = GetKeyboardLayout(0);
        let mut state = [0u8; 256];
        if shift {
            state[0x10] = 0x80;
        }
        let scan = MapVirtualKeyExW(vk, MAPVK_VK_TO_VSC_EX, Some(layout));
        let mut buf = [0u16; 4];
        // Flag 4: leave the keyboard's dead-key state alone, so asking can't
        // eat a pending accent the user is in the middle of typing.
        let n = ToUnicodeEx(vk, scan, &state, &mut buf, 4, Some(layout));
        if n == 1 {
            char::from_u32(buf[0] as u32)
        } else {
            None
        }
    }
}

// Hooks WebView2's AcceleratorKeyPressed on `webview`: a key press that
// matches a shortcut is taken away from the page and runs its command.
pub fn install(app: &tauri::AppHandle, webview: &tauri::Webview) {
    #[cfg(windows)]
    {
        let app2 = app.clone();
        let source = Source::from_label(webview.label());
        let _ = webview.with_webview(move |platform| unsafe {
            if let Err(e) = install_handler(app2, &platform.controller(), source) {
                eprintln!("keys: couldn't hook a webview: {}", e.message());
            }
        });
    }
    #[cfg(not(windows))]
    let _ = (app, webview);
}

#[cfg(windows)]
unsafe fn install_handler(
    app: tauri::AppHandle,
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    source: Source,
) -> windows::core::Result<()> {
    use webview2_com::AcceleratorKeyPressedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_MENU, VK_SHIFT};

    let mut token = 0i64;
    controller.add_AcceleratorKeyPressed(
        &AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_KEY_EVENT_KIND::default();
            args.KeyEventKind(&mut kind)?;
            if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN {
                return Ok(());
            }
            let mut vk = 0u32;
            args.VirtualKey(&mut vk)?;
            // Modifier keys on their own are never shortcuts.
            if matches!(vk, 0x10 | 0x11 | 0x12 | 0xA0..=0xA5 | 0x5B | 0x5C) {
                return Ok(());
            }
            let mut status = COREWEBVIEW2_PHYSICAL_KEY_STATUS::default();
            args.PhysicalKeyStatus(&mut status)?;
            let down = |k: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY| GetKeyState(k.0 as i32) < 0;
            let mut mods = 0u8;
            if down(VK_CONTROL) {
                mods |= CTRL;
            }
            if down(VK_SHIFT) {
                mods |= SHIFT;
            }
            if down(VK_MENU) || status.IsMenuKeyDown.as_bool() {
                mods |= ALT;
            }
            let repeat = status.WasKeyDown.as_bool();
            let typed = typed_char(vk, mods & SHIFT != 0);
            let handled = crate::commands::on_key(&app, &source, vk, mods, typed, repeat);
            if handled {
                args.SetHandled(true)?;
            }
            Ok(())
        })),
        &mut token,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_formats() {
        for text in ["Ctrl+Shift+T", "Alt+Left", "F5", "Ctrl+Plus", "Ctrl+Minus", "Ctrl+0", "Shift+Escape", "Ctrl+PageDown", "BrowserBack", "Ctrl+Shift+Delete", "F12", "Alt+Home", "Ctrl+Shift+]"] {
            let chord = parse_chord(text).unwrap_or_else(|| panic!("{} didn't parse", text));
            assert_eq!(format_chord(&chord), text);
        }
        assert_eq!(parse_chord("ctrl + t"), parse_chord("Ctrl+T"));
        assert_eq!(parse_chord("Ctrl++"), parse_chord("Ctrl+Plus"));
        assert_eq!(parse_chord("Ctrl+-"), parse_chord("Ctrl+Minus"));
        assert_eq!(parse_chord("Esc"), parse_chord("Escape"));
        assert!(parse_chord("Ctrl+Shift").is_none());
        assert!(parse_chord("Ctrl+T+R").is_none());
        assert!(parse_chord("").is_none());
    }

    #[test]
    fn plus_and_minus_ignore_shift() {
        let c = candidates(VK_OEM_PLUS, CTRL | SHIFT, Some('+'));
        assert!(c.contains(&Chord { mods: CTRL, key: Key::Plus }));
        let c = candidates(VK_ADD, CTRL, Some('+'));
        assert!(c.contains(&Chord { mods: CTRL, key: Key::Plus }));
        // Hungarian: + is Shift+3.
        let c = candidates(0x33, CTRL | SHIFT, Some('+'));
        assert!(c.contains(&Chord { mods: CTRL, key: Key::Plus }));
        let c = candidates(VK_SUBTRACT, CTRL, Some('-'));
        assert!(c.contains(&Chord { mods: CTRL, key: Key::Minus }));
    }

    #[test]
    fn sources() {
        assert_eq!(Source::from_label("content-12"), Source::Tab(12));
        assert_eq!(Source::from_label("popout-content-3"), Source::Popout(3));
        assert_eq!(Source::from_label("popout-bar-3"), Source::Popout(3));
        assert_eq!(Source::from_label("side-panel"), Source::SidePanel);
        assert_eq!(Source::from_label("toolbar"), Source::Toolbar);
        assert_eq!(Source::from_label("shields-popup"), Source::Toolbar);
    }
}

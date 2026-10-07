// Addresses and payment cards (Settings -> Addresses & cards, and forms in
// pages): what forms ask for again and again -- your name, email, phone and
// address; a card's number, name and expiry -- kept on this computer and
// filled in with a click on a suggestion under the field (page-tools.js).
// Addresses are kept in addresses.json; cards in cards.dat, encrypted for
// your Windows account (DPAPI, as Chrome keeps them). A card's security code
// is never kept. Kessel decides what a page gets from its real address and
// your click; nothing is filled by itself.

use super::*;

#[derive(Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub(crate) struct Address {
    id: String,
    name: String,
    organization: String,
    street: String,
    city: String,
    region: String,
    postal_code: String,
    country: String,
    phone: String,
    email: String,
    used_at: u64,
}

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub(crate) struct Card {
    id: String,
    name: String,
    number: String,
    exp_month: u8,
    exp_year: u16,
    used_at: u64,
}

const KEPT: usize = 50;

fn enabled(app: &tauri::AppHandle) -> bool {
    app.state::<BrowserState>().store.settings.lock().unwrap().features.get("form_autofill").and_then(|v| v.as_bool()).unwrap_or(true)
}

fn new_id(prefix: &str) -> String {
    format!("{}{}", prefix, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default())
}

fn clean(s: &str, max: usize) -> String {
    s.trim().chars().filter(|c| !c.is_control()).take(max).collect()
}

impl Address {
    fn cleaned(self) -> Address {
        Address {
            id: self.id,
            name: clean(&self.name, 120),
            organization: clean(&self.organization, 120),
            street: clean(&self.street, 200),
            city: clean(&self.city, 100),
            region: clean(&self.region, 100),
            postal_code: clean(&self.postal_code, 20),
            country: clean(&self.country, 60),
            phone: clean(&self.phone, 40),
            email: clean(&self.email, 200),
            used_at: self.used_at,
        }
    }

    fn is_empty(&self) -> bool {
        [&self.name, &self.organization, &self.street, &self.city, &self.postal_code, &self.phone, &self.email].iter().all(|s| s.is_empty())
    }

    // The same address, whatever case or spacing it was typed in.
    fn same_as(&self, other: &Address) -> bool {
        let n = |s: &str| s.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ");
        n(&self.name) == n(&other.name) && n(&self.street) == n(&other.street) && n(&self.postal_code) == n(&other.postal_code) && n(&self.email) == n(&other.email)
    }

    // "Jane Doe, 1 Main St" -- what the suggestion shows.
    fn label(&self) -> String {
        let parts: Vec<&str> = [&self.name, &self.street, &self.email].iter().filter(|s| !s.is_empty()).map(|s| s.as_str()).take(2).collect();
        parts.join(", ")
    }
}

// --- Cards ------------------------------------------------------------------------

pub(crate) fn digits(number: &str) -> String {
    number.chars().filter(|c| c.is_ascii_digit()).collect()
}

// The Luhn check every card number passes.
pub(crate) fn luhn(number: &str) -> bool {
    let d = digits(number);
    if !(12..=19).contains(&d.len()) {
        return false;
    }
    let sum: u32 = d
        .chars()
        .rev()
        .enumerate()
        .map(|(i, c)| {
            let v = c.to_digit(10).unwrap_or(0);
            if i % 2 == 1 {
                let x = v * 2;
                if x > 9 { x - 9 } else { x }
            } else {
                v
            }
        })
        .sum();
    sum % 10 == 0
}

pub(crate) fn brand(number: &str) -> &'static str {
    let d = digits(number);
    let n = |len: usize| d.get(..len).and_then(|p| p.parse::<u32>().ok()).unwrap_or(0);
    if d.starts_with('4') {
        "Visa"
    } else if (51..=55).contains(&n(2)) || (2221..=2720).contains(&n(4)) {
        "Mastercard"
    } else if n(2) == 34 || n(2) == 37 {
        "American Express"
    } else if d.starts_with("6011") || d.starts_with("65") {
        "Discover"
    } else {
        "Card"
    }
}

impl Card {
    fn last4(&self) -> String {
        let d = digits(&self.number);
        d[d.len().saturating_sub(4)..].to_string()
    }

    // "Visa •••• 4242, 12/28"
    fn label(&self) -> String {
        format!("{} \u{2022}\u{2022}\u{2022}\u{2022} {}, {:02}/{:02}", brand(&self.number), self.last4(), self.exp_month, self.exp_year % 100)
    }

    // For lists: never the whole number.
    fn masked(&self) -> serde_json::Value {
        serde_json::json!({ "id": self.id, "name": self.name, "brand": brand(&self.number), "last4": self.last4(), "exp_month": self.exp_month, "exp_year": self.exp_year, "label": self.label() })
    }
}

// --- Keeping them -----------------------------------------------------------------

fn addresses_path(state: &BrowserState) -> PathBuf {
    state.data_dir.join("addresses.json")
}

fn cards_path(state: &BrowserState) -> PathBuf {
    state.data_dir.join("cards.dat")
}

fn read_addresses(state: &BrowserState) -> Vec<Address> {
    store::read_text_recovering(&addresses_path(state), |t| serde_json::from_str::<Vec<Address>>(t).is_ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_addresses(state: &BrowserState, list: &[Address]) -> Result<(), String> {
    store::write_atomic(&addresses_path(state), &serde_json::to_string(list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn read_cards(state: &BrowserState) -> Vec<Card> {
    let Ok(bytes) = std::fs::read(cards_path(state)) else { return Vec::new() };
    dpapi(&bytes, false).ok().and_then(|plain| serde_json::from_slice(&plain).ok()).unwrap_or_default()
}

fn write_cards(state: &BrowserState, list: &[Card]) -> Result<(), String> {
    let plain = serde_json::to_vec(list).map_err(|e| e.to_string())?;
    let sealed = dpapi(&plain, true)?;
    let path = cards_path(state);
    let tmp = path.with_extension("dat.tmp");
    std::fs::write(&tmp, sealed).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

// Windows' own encryption for this user's account: `protect` seals,
// otherwise opens.
#[cfg(windows)]
fn dpapi(data: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        let done = if protect {
            CryptProtectData(&input, &windows::core::HSTRING::from("Kessel cards"), None, None, None, 0, &mut output)
        } else {
            CryptUnprotectData(&input, None, None, None, None, 0, &mut output)
        };
        done.map_err(|e| e.message().to_string())?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut core::ffi::c_void)));
        Ok(bytes)
    }
}

#[cfg(not(windows))]
fn dpapi(_data: &[u8], _protect: bool) -> Result<Vec<u8>, String> {
    Err("Cards are kept only on Windows".into())
}

// --- Pages ------------------------------------------------------------------------

// What a page may fill: never Kessel's own pages, only web pages.
fn page_ok(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://")
}

// Secure enough for a card: https, or a page from this very computer
// (localhost, 127.x, [::1]) -- what browsers count as a secure context.
fn secure(url: &str) -> bool {
    let Ok(u) = tauri::Url::parse(url) else { return false };
    if u.scheme() == "https" {
        return true;
    }
    match u.host_str() {
        Some("localhost") => true,
        Some(h) => h.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()),
        None => false,
    }
}

// The suggestions under a field of `kind` ("address" or "card"): what to
// show, never the data itself.
pub(crate) fn suggest(app: &tauri::AppHandle, url: &str, kind: &str) -> serde_json::Value {
    if !enabled(app) || !page_ok(url) {
        return serde_json::json!([]);
    }
    let state = app.state::<BrowserState>();
    let mut list: Vec<(u64, serde_json::Value)> = match kind {
        "address" => read_addresses(&state).iter().filter(|a| !a.is_empty()).map(|a| (a.used_at, serde_json::json!({ "id": a.id, "label": a.label() }))).collect(),
        // Only cards on a secure page (https, or one on this computer).
        "card" if secure(url) => {
            read_cards(&state).iter().map(|c| (c.used_at, serde_json::json!({ "id": c.id, "label": c.label() }))).collect()
        }
        _ => Vec::new(),
    };
    list.sort_by(|a, b| b.0.cmp(&a.0));
    serde_json::Value::Array(list.into_iter().map(|(_, v)| v).collect())
}

// The one you clicked, to fill the form with.
pub(crate) fn fill(app: &tauri::AppHandle, url: &str, kind: &str, id: &str) -> serde_json::Value {
    if suggest(app, url, kind).as_array().is_none_or(|l| !l.iter().any(|s| s["id"] == id)) {
        return serde_json::Value::Null;
    }
    let state = app.state::<BrowserState>();
    let now = now_unix();
    match kind {
        "address" => {
            let mut list = read_addresses(&state);
            let Some(a) = list.iter_mut().find(|a| a.id == id) else { return serde_json::Value::Null };
            a.used_at = now;
            let out = serde_json::to_value(&*a).unwrap_or_default();
            let _ = write_addresses(&state, &list);
            out
        }
        "card" => {
            let mut list = read_cards(&state);
            let Some(c) = list.iter_mut().find(|c| c.id == id) else { return serde_json::Value::Null };
            c.used_at = now;
            let out = serde_json::json!({ "name": c.name, "number": digits(&c.number), "exp_month": c.exp_month, "exp_year": c.exp_year });
            let _ = write_cards(&state, &list);
            out
        }
        _ => serde_json::Value::Null,
    }
}

// --- The suggestions under a field (forms.html) -------------------------------------
//
// Shown by Kessel, not by the page: the page only says "an address field
// here has the focus", and what you've saved never reaches it until you
// pick one (then it's in the page's fields anyway). Picked with the mouse,
// or with the keys the page passes on (Down, Up, Enter, Esc).

struct Showing {
    tab: u32,
    kind: String,
    url: String,
    label: String,
}
static SHOWING: Mutex<Option<Showing>> = Mutex::new(None);

// A field of `kind` got the focus in tab `id`: its box `rect` (CSS pixels
// in the page, x y width height) and the page's devicePixelRatio.
pub(crate) fn on_focus(app: &tauri::AppHandle, id: u32, url: &str, d: &serde_json::Value) {
    let kind = d.get("kind").and_then(|k| k.as_str()).unwrap_or("").to_string();
    let items = suggest(app, url, &kind);
    let rect: Vec<f64> = d.get("rect").and_then(|r| r.as_array()).map(|r| r.iter().filter_map(|v| v.as_f64()).collect()).unwrap_or_default();
    let dpr = d.get("dpr").and_then(|v| v.as_f64()).filter(|v| *v > 0.1 && *v < 10.0).unwrap_or(1.0);
    let (app2, url) = (app.clone(), url.to_string());
    // (Not inside WebView2's message event: making a webview there deadlocks.)
    later(app, move || {
        if items.as_array().is_none_or(|l| l.is_empty()) || rect.len() != 4 {
            hide(&app2);
        } else {
            show_list(&app2, id, url, kind, items, &rect, dpr);
        }
    });
}

fn show_list(app: &tauri::AppHandle, id: u32, url: String, kind: String, items: serde_json::Value, rect: &[f64], dpr: f64) {
    let state = app.state::<BrowserState>();
    let Some(tab) = state.tabs.lock().unwrap().get(&id).cloned() else { return };
    let window = tab.window();
    let scale = window.scale_factor().unwrap_or(1.0);
    let Ok(at) = tab.position().map(|p| p.to_logical::<f64>(scale)) else { return };
    // CSS pixels in the page -> the window's logical pixels (page zoom).
    let z = dpr / scale;
    let count = items.as_array().map(|l| l.len().min(6)).unwrap_or(0) as f64;
    let (x, y) = (at.x + rect[0] * z, at.y + (rect[1] + rect[3]) * z + 2.0);
    let (width, height) = ((rect[2] * z).clamp(260.0, 420.0), count * 40.0 + 40.0);
    // Already showing for this field (it got the focus again): just moved.
    let same = SHOWING.lock().unwrap().as_ref().filter(|s| s.tab == id && s.kind == kind && s.url == url).map(|s| s.label.clone());
    if let Some(popup) = same.and_then(|label| app.get_webview(&label)) {
        let _ = popup.set_position(LogicalPosition::new(x, y));
        let _ = popup.set_size(LogicalSize::new(width, height));
        return;
    }
    hide(app);
    // (A label of its own: the one before may still be closing.)
    let label = format!("{}-{}", popup_label("forms", window.label()), LIST_SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    let init = format!(
        "window.__KESSEL_POPUP__ = {{ kind: {}, items: {} }};",
        serde_json::to_string(&kind).unwrap_or_default(),
        items
    );
    // Not focused: the keyboard stays in the field (typing goes on there).
    let builder = profile::webview(&label, WebviewUrl::App("forms.html".into())).initialization_script(&init).focused(false);
    match window.add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(width, height)) {
        Ok(popup) => {
            raise_webview(&popup);
            *SHOWING.lock().unwrap() = Some(Showing { tab: id, kind, url, label });
        }
        Err(e) => eprintln!("couldn't show the form suggestions: {}", e),
    }
}

static LIST_SERIAL: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

// The list closed: the field lost the focus, or you typed, or picked.
pub(crate) fn hide(app: &tauri::AppHandle) {
    let showing = SHOWING.lock().unwrap().take();
    if let Some(s) = showing {
        if let Some(popup) = app.get_webview(&s.label) {
            let _ = popup.close();
        }
    }
}

// The field lost the focus: the list goes in a moment (unless you were
// picking from it -- a pick comes first).
pub(crate) fn on_blur(app: &tauri::AppHandle, id: u32) {
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));
        let mine = SHOWING.lock().unwrap().as_ref().is_some_and(|s| s.tab == id);
        if mine {
            let app3 = app2.clone();
            later(&app2, move || hide(&app3));
        }
    });
}

// A key the field passed on: Down, Up, Enter for the list; Esc closes it.
pub(crate) fn on_key(app: &tauri::AppHandle, id: u32, key: &str) {
    let label = SHOWING.lock().unwrap().as_ref().filter(|s| s.tab == id).map(|s| s.label.clone());
    let Some(label) = label else { return };
    if key == "Escape" {
        let app2 = app.clone();
        later(app, move || hide(&app2));
    } else if matches!(key, "ArrowDown" | "ArrowUp" | "Enter") {
        let _ = app.emit_to(label.as_str(), "forms-key", key);
    }
}

// The list's pick: the page gets what to fill in -- if it's still the page
// the list was for.
#[tauri::command]
pub(crate) async fn forms_pick(app: tauri::AppHandle, webview: Webview, id: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    let showing = SHOWING.lock().unwrap().take();
    let _ = webview.close();
    let Some(s) = showing else { return Ok(()) };
    let tab = app.state::<BrowserState>().tabs.lock().unwrap().get(&s.tab).cloned().ok_or("that tab is gone")?;
    if tab.url().map(|u| u.to_string()).ok().as_deref() != Some(s.url.as_str()) {
        return Ok(());
    }
    let data = fill(&app, &s.url, &s.kind, &id);
    if !data.is_null() {
        crate::bridge::post_event(&app, &tab, serde_json::json!({ "kesselEvent": "form-fill", "kind": s.kind, "data": data }));
    }
    Ok(())
}

// What waits for "Save this address?" / "Save this card?" (the newest only).
enum Pending {
    Address(Address),
    Card(Card),
}
static PENDING: Mutex<Option<(u64, Pending)>> = Mutex::new(None);
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

// A form sent with an address or a card in it: offered to keep, if it's new.
pub(crate) fn on_sent(app: &tauri::AppHandle, id: u32, url: &str, d: &serde_json::Value) {
    let state = app.state::<BrowserState>();
    let offer_on = state.store.settings.lock().unwrap().features.get("form_offer").and_then(|v| v.as_bool()).unwrap_or(true);
    if !enabled(app) || !offer_on || !page_ok(url) || state.private_tabs.lock().unwrap().contains(&id) {
        return;
    }
    let s = |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let pending = if let Some(c) = d.get("card").filter(|c| luhn(&s(c, "number"))) {
        let month = s(c, "exp_month").parse::<u8>().ok().filter(|m| (1..=12).contains(m)).unwrap_or(0);
        let year = s(c, "exp_year").parse::<u16>().ok().map(|y| if y < 100 { 2000 + y } else { y }).unwrap_or(0);
        let card = Card { id: String::new(), name: clean(&s(c, "name"), 120), number: digits(&s(c, "number")), exp_month: month, exp_year: year, used_at: 0 };
        if read_cards(&state).iter().any(|k| digits(&k.number) == card.number) {
            return;
        }
        Pending::Card(card)
    } else if let Some(a) = d.get("address") {
        let address = Address {
            name: s(a, "name"),
            organization: s(a, "organization"),
            street: s(a, "street"),
            city: s(a, "city"),
            region: s(a, "region"),
            postal_code: s(a, "postal_code"),
            country: s(a, "country"),
            phone: s(a, "phone"),
            email: s(a, "email"),
            ..Default::default()
        }
        .cleaned();
        // Enough of an address to be worth keeping: a street, or a name
        // with a way to reach you.
        let worth = !address.street.is_empty() || (!address.name.is_empty() && (!address.email.is_empty() || !address.phone.is_empty()));
        if !worth || read_addresses(&state).iter().any(|k| k.same_as(&address)) {
            return;
        }
        Pending::Address(address)
    } else {
        return;
    };
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (kind, label) = match &pending {
        Pending::Address(a) => ("address", a.label()),
        Pending::Card(c) => ("card", c.label()),
    };
    *PENDING.lock().unwrap() = Some((n, pending));
    crash::set_notice(Some(app), serde_json::json!({ "id": "form-offer", "detail": { "offer": n, "kind": kind, "label": label } }));
}

// --- Commands (Settings, the toolbar's notice) ------------------------------------

#[tauri::command]
pub(crate) fn autofill_list(webview: Webview, state: tauri::State<BrowserState>) -> Result<serde_json::Value, String> {
    require_internal_page(&webview)?;
    let cards: Vec<serde_json::Value> = read_cards(&state).iter().map(Card::masked).collect();
    Ok(serde_json::json!({ "addresses": read_addresses(&state), "cards": cards }))
}

#[tauri::command]
pub(crate) fn autofill_save_address(webview: Webview, state: tauri::State<BrowserState>, address: Address) -> Result<String, String> {
    require_internal_page(&webview)?;
    let mut address = address.cleaned();
    if address.is_empty() {
        return Err("An address with nothing in it".into());
    }
    let mut list = read_addresses(&state);
    match list.iter_mut().find(|a| !address.id.is_empty() && a.id == address.id) {
        Some(existing) => {
            address.used_at = existing.used_at;
            *existing = address.clone();
        }
        None => {
            address.id = new_id("a");
            list.push(address.clone());
            if list.len() > KEPT {
                list.remove(0);
            }
        }
    }
    write_addresses(&state, &list)?;
    Ok(address.id)
}

#[tauri::command]
pub(crate) fn autofill_delete_address(webview: Webview, state: tauri::State<BrowserState>, id: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    let mut list = read_addresses(&state);
    list.retain(|a| a.id != id);
    write_addresses(&state, &list)
}

// A card: new, or changed (an empty number keeps the one it had).
#[tauri::command]
pub(crate) fn autofill_save_card(webview: Webview, state: tauri::State<BrowserState>, id: Option<String>, name: String, number: String, exp_month: u8, exp_year: u16) -> Result<String, String> {
    require_internal_page(&webview)?;
    if !(1..=12).contains(&exp_month) || !(2000..=2100).contains(&exp_year) {
        return Err("The expiry date isn't right".into());
    }
    let mut list = read_cards(&state);
    let existing = id.as_deref().and_then(|id| list.iter().position(|c| c.id == id));
    let number = digits(&number);
    if !(number.is_empty() && existing.is_some()) && !luhn(&number) {
        return Err("That isn't a card number".into());
    }
    let card = Card {
        id: existing.map(|i| list[i].id.clone()).unwrap_or_else(|| new_id("c")),
        name: clean(&name, 120),
        number: if number.is_empty() { existing.map(|i| list[i].number.clone()).unwrap_or_default() } else { number },
        exp_month,
        exp_year,
        used_at: existing.map(|i| list[i].used_at).unwrap_or(0),
    };
    let id = card.id.clone();
    match existing {
        Some(i) => list[i] = card,
        None => list.push(card),
    }
    write_cards(&state, &list)?;
    Ok(id)
}

#[tauri::command]
pub(crate) fn autofill_delete_card(webview: Webview, state: tauri::State<BrowserState>, id: String) -> Result<(), String> {
    require_internal_page(&webview)?;
    let mut list = read_cards(&state);
    list.retain(|c| c.id != id);
    write_cards(&state, &list)
}

// The toolbar's "Save this address?" answered: `save` it or not.
#[tauri::command]
pub(crate) fn autofill_offer_answer(app: tauri::AppHandle, webview: Webview, state: tauri::State<BrowserState>, offer: u64, save: bool) -> Result<(), String> {
    require_internal_page(&webview)?;
    let pending = {
        let mut p = PENDING.lock().unwrap();
        match p.take() {
            Some((n, pending)) if n == offer => Some(pending),
            other => {
                *p = other;
                None
            }
        }
    };
    crash::drop_notice(&app, "form-offer");
    let Some(pending) = pending.filter(|_| save) else { return Ok(()) };
    match pending {
        Pending::Address(mut a) => {
            a.id = new_id("a");
            let mut list = read_addresses(&state);
            list.push(a);
            write_addresses(&state, &list)
        }
        Pending::Card(mut c) => {
            c.id = new_id("c");
            let mut list = read_cards(&state);
            list.push(c);
            write_cards(&state, &list)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_numbers() {
        assert!(luhn("4242 4242 4242 4242"));
        assert!(luhn("5555-5555-5555-4444"));
        assert!(!luhn("4242 4242 4242 4241"), "a typo");
        assert!(!luhn("1234"), "too short");
        assert_eq!(brand("4242424242424242"), "Visa");
        assert_eq!(brand("5555555555554444"), "Mastercard");
        assert_eq!(brand("2223003122003222"), "Mastercard");
        assert_eq!(brand("378282246310005"), "American Express");
        let c = Card { number: "4242424242424242".into(), exp_month: 3, exp_year: 2031, ..Default::default() };
        assert_eq!(c.label(), "Visa \u{2022}\u{2022}\u{2022}\u{2022} 4242, 03/31");
        assert!(!c.masked().to_string().contains("424242424242"), "never the whole number");
    }

    #[test]
    fn sealed_for_this_windows_account() {
        let sealed = dpapi(b"4242424242424242", true).unwrap();
        assert!(!sealed.windows(16).any(|w| w == b"4242424242424242"), "not readable as it is");
        assert_eq!(dpapi(&sealed, false).unwrap(), b"4242424242424242");
    }

    #[test]
    fn cards_only_on_secure_pages() {
        assert!(secure("https://shop.example/pay"));
        assert!(secure("http://localhost:3000/"));
        assert!(secure("http://127.0.0.2:5000/checkout"));
        assert!(secure("http://[::1]/"));
        assert!(!secure("http://shop.example/pay"));
        assert!(!secure("http://127.evil.example/"));
    }

    #[test]
    fn the_same_address_typed_again() {
        let a = Address { name: "Jane  Doe".into(), street: "1 Main St".into(), ..Default::default() };
        let b = Address { name: "jane doe".into(), street: "1 main st".into(), ..Default::default() };
        assert!(a.same_as(&b));
        assert_eq!(a.label(), "Jane  Doe, 1 Main St");
    }
}

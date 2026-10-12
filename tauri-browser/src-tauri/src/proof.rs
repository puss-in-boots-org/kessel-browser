// Spelling and grammar in what you type (Settings -> Page tools). The engine
// checks neither, so Kessel does:
// - Spelling with Windows' own spell checker, for the languages Windows has
//   dictionaries for -- on this computer, nothing leaves it. Words it doesn't
//   know are underlined in red; right-click one for suggestions, "Add to
//   dictionary" (Windows' own, shared with other programs) or "Ignore".
// - Grammar, if you turn it on, with LanguageTool (languagetool.org): what
//   you type in a field is sent there to be checked, and what it finds is
//   underlined in blue, with its suggestions on right-click.
// The underlines and the menu are page-tools.js's.

use super::*;

pub(crate) fn page_options(f: &serde_json::Value) -> serde_json::Value {
    let p = f.get("proofing").cloned().unwrap_or_default();
    serde_json::json!({
        "spell": p.get("spell").and_then(|v| v.as_bool()).unwrap_or(true),
        "grammar": p.get("grammar").and_then(|v| v.as_bool()).unwrap_or(false),
        "lang": p.get("lang").and_then(|v| v.as_str()).unwrap_or(""),
    })
}

// --- Spelling (Windows' spell checker) -------------------------------------------------------

#[cfg(windows)]
mod win {
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Globalization::{ISpellChecker, ISpellCheckerFactory, SpellCheckerFactory, CORRECTIVE_ACTION_DELETE, CORRECTIVE_ACTION_REPLACE};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, IEnumString, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};

    fn take(p: PWSTR) -> String {
        if p.is_null() {
            return String::new();
        }
        let s = unsafe { p.to_string() }.unwrap_or_default();
        unsafe { CoTaskMemFree(Some(p.0 as *const _)) };
        s
    }

    fn strings(list: IEnumString, most: usize) -> Vec<String> {
        let mut out = Vec::new();
        while out.len() < most {
            let mut item = [PWSTR::null()];
            let mut got = 0u32;
            if unsafe { list.Next(&mut item, Some(&mut got)) }.is_err() || got == 0 {
                break;
            }
            out.push(take(item[0]));
        }
        out
    }

    // The languages Windows can check (BCP-47 tags: "en-US", "hu-HU").
    pub fn languages() -> Vec<String> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let Ok(factory) = CoCreateInstance::<_, ISpellCheckerFactory>(&SpellCheckerFactory, None, CLSCTX_INPROC_SERVER) else { return Vec::new() };
            factory.SupportedLanguages().map(|l| strings(l, 200)).unwrap_or_default()
        }
    }

    // A spell checker for `lang` (or the same language as spoken elsewhere:
    // en-GB for en-US). None when Windows has no dictionary for it -- a
    // language checked with another's dictionary would be all red.
    pub fn checker(lang: &str) -> Option<ISpellChecker> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let factory: ISpellCheckerFactory = CoCreateInstance(&SpellCheckerFactory, None, CLSCTX_INPROC_SERVER).ok()?;
            let supported = factory.SupportedLanguages().map(|l| strings(l, 200)).unwrap_or_default();
            let primary = |t: &str| t.split(['-', '_']).next().unwrap_or("").to_ascii_lowercase();
            let tag = supported
                .iter()
                .find(|t| t.eq_ignore_ascii_case(lang))
                .or_else(|| supported.iter().find(|t| !lang.is_empty() && primary(t) == primary(lang)))?;
            factory.CreateSpellChecker(&HSTRING::from(tag.as_str())).ok()
        }
    }

    // The words `text` gets wrong: (start, length, what to put instead: a
    // word, "" to delete, None to ask for suggestions) -- in UTF-16 units,
    // as the page counts.
    pub fn check(c: &ISpellChecker, text: &str) -> Vec<(u32, u32, Option<String>)> {
        let mut out = Vec::new();
        unsafe {
            let Ok(errors) = c.Check(&HSTRING::from(text)) else { return out };
            loop {
                let mut one = None;
                if errors.Next(&mut one).is_err() {
                    break;
                }
                let Some(e) = one else { break };
                let (Ok(start), Ok(length)) = (e.StartIndex(), e.Length()) else { continue };
                let fix = match e.CorrectiveAction() {
                    Ok(a) if a == CORRECTIVE_ACTION_REPLACE => e.Replacement().ok().map(take),
                    Ok(a) if a == CORRECTIVE_ACTION_DELETE => Some(String::new()),
                    _ => None,
                };
                out.push((start, length, fix));
                if out.len() >= 500 {
                    break;
                }
            }
        }
        out
    }

    pub fn suggest(c: &ISpellChecker, word: &str) -> Vec<String> {
        unsafe { c.Suggest(&HSTRING::from(word)).map(|l| strings(l, 6)).unwrap_or_default() }
    }

    pub fn add(c: &ISpellChecker, word: &str) {
        unsafe {
            let _ = c.Add(&HSTRING::from(word));
        }
    }

    pub fn ignore(c: &ISpellChecker, word: &str) {
        unsafe {
            let _ = c.Ignore(&HSTRING::from(word));
        }
    }
}

const MOST: usize = 20_000;

// The page's "proof-check": what's misspelled in `text` (language `lang`).
pub(crate) fn check(text: &str, lang: &str) -> serde_json::Value {
    #[cfg(windows)]
    {
        let text: String = text.chars().take(MOST).collect();
        let Some(c) = win::checker(lang) else { return serde_json::json!([]) };
        serde_json::Value::Array(
            win::check(&c, &text)
                .into_iter()
                .map(|(start, length, fix)| serde_json::json!({ "start": start, "length": length, "kind": "spell", "replacements": fix.map(|f| vec![f]).unwrap_or_default() }))
                .collect(),
        )
    }
    #[cfg(not(windows))]
    {
        let _ = (text, lang);
        serde_json::json!([])
    }
}

pub(crate) fn suggest(word: &str, lang: &str) -> serde_json::Value {
    #[cfg(windows)]
    {
        let word: String = word.chars().take(100).collect();
        serde_json::json!(win::checker(lang).map(|c| win::suggest(&c, &word)).unwrap_or_default())
    }
    #[cfg(not(windows))]
    {
        let _ = (word, lang);
        serde_json::json!([])
    }
}

// "Add to dictionary" / "Ignore" from the menu.
pub(crate) fn learn(word: &str, lang: &str, add: bool) {
    #[cfg(windows)]
    if let Some(c) = win::checker(lang) {
        let word: String = word.chars().take(100).collect();
        if add {
            win::add(&c, &word);
        } else {
            win::ignore(&c, &word);
        }
    }
    #[cfg(not(windows))]
    let _ = (word, lang, add);
}

// Settings: the languages Windows can check.
#[tauri::command]
pub(crate) async fn proof_languages(webview: Webview) -> Result<Vec<String>, String> {
    require_internal_page(&webview)?;
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(win::languages).await.map_err(|e| e.to_string());
    #[cfg(not(windows))]
    Ok(Vec::new())
}

// --- Grammar (LanguageTool) -------------------------------------------------------------------

const LANGUAGETOOL: &str = "https://api.languagetool.org/v2/check";

// What LanguageTool found, as the page's ranges.
pub(crate) fn matches_from(answer: &serde_json::Value) -> Vec<serde_json::Value> {
    answer
        .get("matches")
        .and_then(|m| m.as_array())
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let start = m.get("offset")?.as_u64()?;
            let length = m.get("length")?.as_u64()?;
            // (Spelling is Windows' -- LanguageTool's spelling finds are left out.)
            let spelling = m.pointer("/rule/issueType").and_then(|t| t.as_str()) == Some("misspelling");
            if spelling || length == 0 {
                return None;
            }
            let replacements: Vec<String> = m.get("replacements").and_then(|r| r.as_array()).into_iter().flatten().filter_map(|r| r.get("value")?.as_str().map(str::to_string)).take(5).collect();
            Some(serde_json::json!({ "start": start, "length": length, "kind": "grammar", "message": m.get("message").and_then(|v| v.as_str()).unwrap_or(""), "replacements": replacements }))
        })
        .take(200)
        .collect()
}

// The page's "proof-grammar": `text` checked (when you turned grammar on),
// the answer sent back to page `label` as its "proof-grammar" event.
pub(crate) fn grammar(app: &tauri::AppHandle, label: &str, seq: u64, text: &str, lang: &str) {
    let f = app.state::<BrowserState>().store.settings.lock().unwrap().features.clone();
    if page_options(&f).get("grammar").and_then(|v| v.as_bool()) != Some(true) {
        return;
    }
    // (A test run checks with a server of its own.)
    let server = f.pointer("/proofing/grammar_server").and_then(|v| v.as_str()).filter(|_| profile::remote_debugging_port().is_some()).unwrap_or(LANGUAGETOOL).to_string();
    let (app2, label, text, lang) = (app.clone(), label.to_string(), text.chars().take(MOST).collect::<String>(), if lang.is_empty() { "auto".to_string() } else { lang.to_string() });
    std::thread::spawn(move || {
        use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .tls_config(TlsConfig::builder().provider(TlsProvider::NativeTls).root_certs(RootCerts::PlatformVerifier).build())
            .timeout_global(Some(Duration::from_secs(15)))
            .build()
            .into();
        let answer = agent.post(&server).send_form([("text", text.as_str()), ("language", lang.as_str())]).ok().and_then(|mut r| r.body_mut().with_config().limit(2 * 1024 * 1024).read_to_string().ok()).and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
        let Some(answer) = answer else { return };
        let matches = matches_from(&answer);
        if let Some(page) = app2.get_webview(&label) {
            crate::bridge::post_event(&app2, &page, serde_json::json!({ "kesselEvent": "proof-grammar", "seq": seq, "matches": matches }));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_languagetool_found() {
        let answer = serde_json::json!({ "matches": [
            { "offset": 3, "length": 2, "message": "Use “an”", "replacements": [{ "value": "an" }], "rule": { "issueType": "grammar" } },
            { "offset": 9, "length": 5, "message": "Possible spelling mistake", "replacements": [{ "value": "wrong" }], "rule": { "issueType": "misspelling" } }
        ] });
        let found = matches_from(&answer);
        assert_eq!(found.len(), 1, "spelling is Windows' job");
        assert_eq!(found[0]["start"], 3);
        assert_eq!(found[0]["replacements"][0], "an");
        assert_eq!(found[0]["kind"], "grammar");
    }

    #[test]
    #[cfg(windows)]
    fn windows_finds_misspelled_words() {
        // (With the dictionaries this PC has: English, Hungarian, or both.)
        let langs = win::languages();
        let starts = |text: &str, lang: &str| -> Vec<u64> { check(text, lang).as_array().unwrap().iter().map(|e| e["start"].as_u64().unwrap()).collect() };
        if langs.iter().any(|l| l.starts_with("en")) {
            assert_eq!(starts("This is a wrnog sentense", "en-US"), vec![10, 16], "wrnog and sentense");
            assert!(suggest("wrnog", "en-US").as_array().unwrap().iter().any(|s| s == "wrong"));
        } else {
            assert_eq!(starts("This is a wrnog sentense", "en-US"), Vec::<u64>::new(), "no English dictionary: not checked as another language");
        }
        if langs.iter().any(|l| l.starts_with("hu")) {
            assert_eq!(starts("Ez egy hibás mondaat", "hu"), vec![13], "mondaat");
            assert!(suggest("mondaat", "hu-HU").as_array().unwrap().iter().any(|s| s == "mondat"));
        }
    }
}

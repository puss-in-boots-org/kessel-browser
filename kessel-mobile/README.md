# Kessel for phones

Kessel on Android: the desktop browser's address bar, Shields, private
tabs, bookmarks and history, laid out for one hand, with the parts that
can't work on a phone left out.

## Installing

Every push that touches the phone app builds its installers on GitHub
(`.github/workflows/android.yml`): open the run in the repository's
**Actions** tab and download the `kessel-android-…` artifact:

- `Kessel-<version>.apk`: install it directly. Copy it to the phone,
  open it, and allow your file manager or browser to install apps when
  Android asks.
- `Kessel-<version>.aab`: an App Bundle, for publishing on Google Play.

Android 10 or later. Private tabs need a recent Android System WebView
(updated through the Play Store). With an older WebView, Kessel doesn't
offer private tabs at all.

### Signing

Without a key the release is signed with a throw-away debug key. It
installs fine, but a later build signed with a real key can't update it
(uninstall first). To sign releases, add four repository secrets:

| Secret | What |
|---|---|
| `KESSEL_KEYSTORE_BASE64` | The keystore, `base64 -w0 kessel.jks` |
| `KESSEL_KEYSTORE_PASSWORD` | Its password |
| `KESSEL_KEY_ALIAS` | The key's alias |
| `KESSEL_KEY_PASSWORD` | The key's password |

Make a keystore with
`keytool -genkeypair -v -keystore kessel.jks -keyalg RSA -keysize 4096 -validity 10000 -alias kessel`,
and keep it safe: every update has to be signed with the same key.

## What's in it

| | |
|---|---|
| **Address bar** | At the bottom (or top), where your thumb is. The same suggestions as the desktop: completing sites you've been to, open tabs, bookmarks, history, your search engine's suggestions (never from a private tab), and instant answers: calculator, units, currencies, definitions, the time anywhere. Swipe along it to change tabs. |
| **Tabs** | A grid of your tabs with pictures of them. Swipe a card to close it. Hold the tabs button for a new or private tab. Pages beyond a few (Settings → Tabs) sleep and reload when you go back, like the desktop's sleeping tabs. Your tabs come back after a restart. |
| **Private tabs** | Their own cookies, storage and cache, deleted when the last private tab closes. No history, no suggestions sent anywhere. |
| **Shields** | Ad and tracking servers from EasyList, EasyPrivacy and Peter Lowe's list are blocked before the request leaves the phone. Tracking parameters (`utm_`, `fbclid`...) are removed from links. Turn them off for a site from the lock beside its address. The lists update themselves. |
| **Pages** | Find in page, desktop site, share, add to home screen, print or save as PDF, text size, dark pages. Long-press a link or picture to open it in a new, background or private tab, copy, share or download it. |
| **Video** | Fullscreen video. Leave Kessel while one plays and it goes on in picture-in-picture. |
| **Permissions** | Camera, microphone and location only after you allow them, remembered per site if you want. Settings → Site permissions resets them. Pop-ups a page opens without a tap are blocked. |
| **Downloads** | To the phone's Downloads folder, with progress in the notification shade. Files a page makes itself (`data:` and `blob:`) too. |
| **Other apps** | Kessel can be your default browser (Settings), opens links, searches and shared text from other apps, and has "New tab" / "New private tab" shortcuts on its icon. |
| **Bookmarks, history** | Search, rename, delete. History by day, kept for as long as you choose. Clear browsing data by time range. |

## Left on the desktop

These are part of the desktop Kessel but not the phone's, because they
don't work on a phone or need what Android's WebView doesn't have:

- More than one window, split view, the side panel, pop-out windows, vertical tabs, tab groups, dragging tabs between windows.
- The password vault and its autofill, and importing from other browsers (Android's own autofill and password manager still work in pages).
- Extensions, keyboard shortcuts, mouse gestures, hover cards.
- Shields' element hiding and scriptlets (the phone blocks by server), fingerprinting protection, and the engine's tracking-prevention levels.
- Media controls, hardware-acceleration settings, `kessel://gpu`, the task manager and developer tools: WebView doesn't expose them on a phone.

## How it's built

```
app/src/main/java/com/kessel/browser/   the browser (Kotlin)
  MainActivity.kt   the screen: the page, Kessel's UI over it, fullscreen, Back, other apps
  Browser.kt        tabs and their WebViews: loading, sleeping, pop-ups, errors, long-press
  Bridge.kt         the commands the UI sends
  Store.kt          settings, bookmarks, history, permissions, downloads, session (JSON files)
  Shields.kt        the filter lists' server rules, matched per request
  Downloads.kt, Permissions.kt, Net.kt (suggestions, currency rates, definitions), UrlTools.kt
app/src/main/assets/ui/                 Kessel's UI (HTML, CSS, JS) in a WebView over the page
  app.js, suggest.js, bridge.js, app.css
```

The UI reuses the desktop's `answers.js` (calculator, conversions...),
`icons.js` and `api.js`, copied from `../tauri-browser/src/shared/` at
build time. The version comes from `../tauri-browser/package.json`.

### Building it yourself

JDK 17 and the Android SDK (Android Studio has both):

```
node scripts/fetch-mobile-shields.mjs     # the filter lists the app ships with (optional)
cd kessel-mobile
./gradlew assembleRelease                 # app/build/outputs/apk/release/app-release.apk
./gradlew bundleRelease                   # app/build/outputs/bundle/release/app-release.aab
./gradlew testReleaseUnitTest             # the Kotlin unit tests
```

Or open `kessel-mobile/` in Android Studio and run it on a phone or emulator.

### Tests

- `node --test kessel-mobile/tests/*.test.mjs`: the address bar's logic.
- `./gradlew testReleaseUnitTest`: Shields' rule matching, link cleaning, the suggestion and rate parsers.
- `node kessel-mobile/tests/preview/preview.mjs out-dir`: every screen of the UI in a desktop Chromium at a phone's size, with a pretend browser behind it. It takes screenshots and fails on any script error. It needs `npm i playwright`.

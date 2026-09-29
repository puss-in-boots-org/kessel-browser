package com.kessel.browser

import android.annotation.SuppressLint
import android.app.Activity
import android.app.PictureInPictureParams
import android.app.SearchManager
import android.app.role.RoleManager
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentCallbacks2
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.print.PrintAttributes
import android.print.PrintManager
import android.provider.Settings
import android.util.Base64
import android.util.Rational
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import java.io.File
import org.json.JSONObject

// Kessel for phones. One screen: the page (the active tab's WebView) and
// Kessel's own UI -- the address bar, tab switcher, menus, settings -- in a
// second WebView (assets/ui) over it: a bar at the bottom (or top) of the
// screen, or the whole screen while a sheet or the tab switcher is open.
// The same split as the desktop's toolbar and page webviews.
class MainActivity : Activity() {
    companion object {
        const val UI_HOST = "appassets.androidplatform.net"
        const val UI_URL = "https://$UI_HOST/assets/ui/index.html"
        private const val RC_FILES = 1
        private const val RC_ROLE = 2
        private const val RC_PERMISSIONS = 100
    }

    lateinit var store: Store
    lateinit var shields: Shields
    lateinit var browser: Browser
    lateinit var downloads: Downloads
    lateinit var permissions: Permissions
    private lateinit var bridge: Bridge

    private lateinit var root: FrameLayout
    private lateinit var content: FrameLayout
    private lateinit var ui: WebView
    private val assets by lazy { WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build() }

    private var ready = false
    private val queued = ArrayList<String>()
    private var uiMode = "bar"
    private var barHeight = 0
    private var barTop = false
    private var barColor = Color.BLACK
    private var darkBars = true

    private var fullscreenView: View? = null
    private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var nextPermissionCode = RC_PERMISSIONS
    private val permissionCallbacks = HashMap<Int, () -> Unit>()

    // --- Start ---------------------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) WebView.setWebContentsDebuggingEnabled(true)

        store = Store(File(filesDir, "kessel"))
        shields = Shields(this)
        shields.enabled = store.bool("adblock_enabled")
        shields.offSites = store.offSites()
        browser = Browser(this, store, shields)
        downloads = Downloads(this, store)
        permissions = Permissions(this, store)
        bridge = Bridge(this)

        barHeight = dp(56)
        drawEdgeToEdge()
        root = FrameLayout(this)
        content = FrameLayout(this)
        root.addView(content, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        ui = WebView(this)
        ui.setBackgroundColor(Color.TRANSPARENT)
        ui.settings.javaScriptEnabled = true
        ui.settings.domStorageEnabled = true
        ui.settings.allowFileAccess = false
        ui.settings.allowContentAccess = false
        ui.settings.textZoom = 100
        ui.settings.setSupportZoom(false)
        ui.isVerticalScrollBarEnabled = false
        ui.overScrollMode = View.OVER_SCROLL_NEVER
        ui.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assets.shouldInterceptRequest(request.url)

            // The UI never goes anywhere else: a link in it opens in a tab.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == UI_HOST) return false
                browser.newTab(request.url.toString(), false, true)
                return true
            }
        }
        ui.webChromeClient = WebChromeClient()
        ui.addJavascriptInterface(bridge, "KesselNative")
        root.addView(ui, uiLayout())
        root.setOnApplyWindowInsetsListener { _, insets -> applyInsets(insets) }
        setContentView(root)
        applyTheme()
        ui.loadUrl(UI_URL)

        shields.load { runOnUiThread { emit("shields-lists", JSONObject().put("rules", shields.ruleCount)) } }
        browser.restore()
        handleIntent(intent)
    }

    // Called by the UI once it has loaded: everything it needs to draw.
    fun uiReady(): JSONObject {
        ready = true
        val info = appInfo()
            .put("settings", store.settings)
            .put("tabs", browser.tabsJson())
            .put("active", browser.active?.id ?: 0)
            .put("closed", browser.closedCount())
        ui.post {
            queued.forEach { ui.evaluateJavascript(it, null) }
            queued.clear()
        }
        return info
    }

    fun appInfo(): JSONObject {
        val webview = WebViewCompat.getCurrentWebViewPackage(this)
        val version = packageManager.getPackageInfo(packageName, 0).versionName
        return JSONObject()
            .put("version", version)
            .put("webview", webview?.versionName ?: "")
            .put("android", Build.VERSION.RELEASE)
            .put("privateSupported", browser.privateSupported)
            .put("isDefault", isDefaultBrowser())
    }

    fun isUiShowingKessel(): Boolean = ui.url?.startsWith("https://$UI_HOST/") == true

    // --- Talking to the UI ------------------------------------------------------------------------

    fun runJs(js: String) {
        if (ready) ui.evaluateJavascript(js, null) else queued.add(js)
    }

    // Android's own toasts: they show wherever Kessel's UI is (even when
    // it's just the bar) and over other apps' screens.
    fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_SHORT).show()

    fun emit(name: String, payload: Any?) {
        runJs("window.__kesselEvent && window.__kesselEvent(${JSONObject.quote(name)},${Bridge.json(payload)})")
    }

    // --- Layout ------------------------------------------------------------------------------------

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    private fun uiLayout(): FrameLayout.LayoutParams =
        if (uiMode == "full") FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        else FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, barHeight, if (barTop) Gravity.TOP else Gravity.BOTTOM)

    // "bar": just the address bar, `height` CSS pixels, the page beside it;
    // "full": the UI over everything (tab switcher, menus, typing an address).
    fun setUiMode(mode: String, height: Int, position: String) {
        uiMode = mode
        barHeight = dp(height)
        barTop = position == "top"
        ui.layoutParams = uiLayout()
        content.layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT).apply {
            if (barTop) topMargin = barHeight else bottomMargin = barHeight
        }
    }

    // The active tab's page, or nothing (the new tab page is the UI's).
    fun showPage(webView: WebView?) {
        if (webView != null && webView.parent === content && content.childCount == 1) return
        content.removeAllViews()
        if (webView != null) {
            (webView.parent as? ViewGroup)?.removeView(webView)
            content.addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
    }

    // --- Edge to edge: the app draws behind the status and navigation bars ---

    @Suppress("DEPRECATION")
    private fun drawEdgeToEdge() {
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
        } else {
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
        }
    }

    // The bars and the keyboard become padding around everything, and stop
    // here: the pages inside mustn't make room for them a second time.
    @Suppress("DEPRECATION")
    private fun applyInsets(insets: WindowInsets): WindowInsets {
        if (Build.VERSION.SDK_INT >= 30) {
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            val ime = insets.getInsets(WindowInsets.Type.ime())
            root.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            return WindowInsets.CONSUMED
        }
        root.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
        return insets.consumeSystemWindowInsets()
    }

    fun isDarkUi(): Boolean = when (store.string("theme")) {
        "dark" -> true
        "light" -> false
        else -> (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    }

    fun applyTheme() {
        setBarColors(null, isDarkUi())
    }

    // The colour behind the status and navigation bars, and their icons.
    @Suppress("DEPRECATION")
    fun setBarColors(bg: String?, dark: Boolean) {
        bg?.let { runCatching { barColor = Color.parseColor(it) } } ?: run { barColor = if (dark) Color.parseColor("#0b0c10") else Color.parseColor("#f4f5f8") }
        darkBars = dark
        root.setBackgroundColor(barColor)
        if (Build.VERSION.SDK_INT >= 30) {
            val light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(if (dark) 0 else light, light)
        } else {
            val flags = window.decorView.systemUiVisibility
            val light = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
            window.decorView.systemUiVisibility = if (dark) flags and light.inv() else flags or light
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // Dark mode switched in Android: the UI follows (theme "system").
        emit("system-theme", JSONObject().put("dark", (newConfig.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES))
    }

    // --- Fullscreen video, and picture-in-picture when you leave it ---

    fun enterFullscreen(view: View, callback: WebChromeClient.CustomViewCallback) {
        if (fullscreenView != null) {
            callback.onCustomViewHidden()
            return
        }
        fullscreenView = view
        fullscreenCallback = callback
        view.setBackgroundColor(Color.BLACK)
        (window.decorView as ViewGroup).addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setSystemBarsHidden(true)
        emit("fullscreen", JSONObject().put("on", true))
    }

    fun exitFullscreen() {
        val view = fullscreenView ?: return
        (window.decorView as ViewGroup).removeView(view)
        fullscreenView = null
        setSystemBarsHidden(false)
        fullscreenCallback?.onCustomViewHidden()
        fullscreenCallback = null
        emit("fullscreen", JSONObject().put("on", false))
    }

    @Suppress("DEPRECATION")
    private fun setSystemBarsHidden(hidden: Boolean) {
        if (Build.VERSION.SDK_INT >= 30) {
            val c = window.insetsController ?: return
            if (hidden) {
                c.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                c.hide(WindowInsets.Type.systemBars())
            } else {
                c.show(WindowInsets.Type.systemBars())
            }
        } else {
            window.decorView.systemUiVisibility = if (hidden) {
                View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            } else {
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            }
            setBarColors(null, darkBars)
        }
    }

    // Leaving Kessel (Home) while a video plays fullscreen: it keeps playing
    // in a small window.
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        val view = fullscreenView ?: return
        val ratio = if (view.width > 0 && view.height > 0) Rational(view.width, view.height) else Rational(16, 9)
        val clamped = when {
            ratio.toFloat() > 2.39f -> Rational(239, 100)
            ratio.toFloat() < 0.42f -> Rational(42, 100)
            else -> ratio
        }
        runCatching { enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(clamped).build()) }
    }

    // --- Back ---------------------------------------------------------------------------------------

    @Deprecated("Kessel handles Back itself: menus, then the page's history, then the tab that opened this one.")
    override fun onBackPressed() {
        if (fullscreenView != null) return exitFullscreen()
        // The UI first: an open menu, the tab switcher, a search being typed.
        ui.evaluateJavascript("window.__kesselBack ? window.__kesselBack() : false") { handled ->
            if (handled == "true") return@evaluateJavascript
            val tab = browser.active
            if (tab != null && browser.goBack(tab)) return@evaluateJavascript
            moveTaskToBack(true)
        }
    }

    // --- Other apps ---------------------------------------------------------------------------------

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    // A link from another app, a search, shared text, a home-screen shortcut.
    private fun handleIntent(intent: Intent?) {
        intent ?: return
        when (intent.action) {
            Intent.ACTION_VIEW -> intent.dataString?.let { url ->
                if (url.startsWith("http://") || url.startsWith("https://")) browser.newTab(url, false, true)
            }
            Intent.ACTION_WEB_SEARCH -> intent.getStringExtra(SearchManager.QUERY)?.let { emit("open", JSONObject().put("text", it)) }
            Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)?.let { emit("open", JSONObject().put("text", it)) }
            "com.kessel.browser.NEW_TAB" -> emit("new-tab", JSONObject().put("private", false))
            "com.kessel.browser.NEW_PRIVATE_TAB" -> emit("new-tab", JSONObject().put("private", browser.privateSupported))
        }
    }

    // mailto:, tel:, intent: and other apps' links from a page.
    fun openExternal(url: String, userTapped: Boolean, view: WebView) {
        try {
            if (url.startsWith("intent:", true)) {
                val intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME).apply {
                    addCategory(Intent.CATEGORY_BROWSABLE)
                    component = null
                    selector = null
                }
                val fallback = intent.getStringExtra("browser_fallback_url")
                if (userTapped) {
                    try {
                        startActivity(intent)
                        return
                    } catch (e: ActivityNotFoundException) {
                        // Not installed: the page's own fallback, or the app's store page.
                    }
                }
                if (fallback != null && (fallback.startsWith("https://") || fallback.startsWith("http://"))) {
                    view.loadUrl(fallback)
                } else if (userTapped) {
                    intent.`package`?.let { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$it"))) }
                }
                return
            }
            if (!userTapped) return
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (e: Exception) {
            toast("No app on this phone opens this link")
        }
    }

    fun share(url: String, title: String) {
        if (url.isEmpty()) return
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url)
        if (title.isNotBlank()) send.putExtra(Intent.EXTRA_SUBJECT, title)
        startActivity(Intent.createChooser(send, null))
    }

    fun copy(text: String) {
        getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("Kessel", text))
        // Android 13+ shows its own "Copied" confirmation.
        if (Build.VERSION.SDK_INT < 33) toast("Copied")
    }

    // Print, or "Save as PDF" in Android's print screen.
    fun print(tab: Tab) {
        val wv = tab.webView ?: return
        val name = tab.title.ifBlank { "Kessel page" }
        getSystemService(PrintManager::class.java)?.print(name, wv.createPrintDocumentAdapter(name), PrintAttributes.Builder().build())
    }

    fun addToHomeScreen(tab: Tab) {
        if (tab.url.isEmpty()) return
        val shortcuts = getSystemService(ShortcutManager::class.java)
        if (shortcuts == null || !shortcuts.isRequestPinShortcutSupported) {
            toast("Your home screen doesn't take shortcuts")
            return
        }
        val label = tab.title.ifBlank { UrlTools.hostOf(tab.url) }.take(40)
        val info = ShortcutInfo.Builder(this, "site-" + tab.url.hashCode())
            .setShortLabel(label)
            .setIcon(Icon.createWithBitmap(shortcutIcon(tab)))
            .setIntent(Intent(Intent.ACTION_VIEW, Uri.parse(tab.url), this, MainActivity::class.java))
            .build()
        shortcuts.requestPinShortcut(info, null)
    }

    // The site's icon on Kessel's colour, or its first letter.
    private fun shortcutIcon(tab: Tab): Bitmap {
        val size = dp(48)
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        paint.color = Color.parseColor("#4285F4")
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)
        val favicon = tab.favicon.substringAfter("base64,", "").takeIf { it.isNotEmpty() }?.let {
            runCatching { Base64.decode(it, Base64.DEFAULT) }.getOrNull()?.let { bytes -> BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }
        }
        if (favicon != null) {
            paint.color = Color.WHITE
            canvas.drawCircle(size / 2f, size / 2f, size / 2f - dp(1), paint)
            val inset = size / 4
            canvas.drawBitmap(favicon, null, android.graphics.Rect(inset, inset, size - inset, size - inset), Paint(Paint.FILTER_BITMAP_FLAG))
        } else {
            paint.color = Color.WHITE
            paint.textSize = size * 0.5f
            paint.textAlign = Paint.Align.CENTER
            paint.isFakeBoldText = true
            val letter = UrlTools.hostOf(tab.url).removePrefix("www.").take(1).uppercase().ifEmpty { "K" }
            canvas.drawText(letter, size / 2f, size / 2f - (paint.descent() + paint.ascent()) / 2, paint)
        }
        return bitmap
    }

    // --- Default browser ---

    private fun isDefaultBrowser(): Boolean {
        val role = getSystemService(RoleManager::class.java)
        return role != null && role.isRoleAvailable(RoleManager.ROLE_BROWSER) && role.isRoleHeld(RoleManager.ROLE_BROWSER)
    }

    fun requestDefaultBrowser() {
        val role = getSystemService(RoleManager::class.java)
        if (role != null && role.isRoleAvailable(RoleManager.ROLE_BROWSER) && !role.isRoleHeld(RoleManager.ROLE_BROWSER)) {
            @Suppress("DEPRECATION")
            startActivityForResult(role.createRequestRoleIntent(RoleManager.ROLE_BROWSER), RC_ROLE)
        } else {
            runCatching { startActivity(Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS)) }
        }
    }

    // --- Files a page asks for, and Android's permissions ---

    fun chooseFiles(callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        fileCallback?.onReceiveValue(null)
        fileCallback = callback
        return try {
            @Suppress("DEPRECATION")
            startActivityForResult(params.createIntent(), RC_FILES)
            true
        } catch (e: Exception) {
            fileCallback = null
            toast("No app on this phone can pick files")
            false
        }
    }

    @Deprecated("Deprecated in Android")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            RC_FILES -> {
                fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
                fileCallback = null
            }
            RC_ROLE -> emit("app-info", appInfo())
        }
    }

    fun requestAndroidPermissions(permissions: List<String>, done: () -> Unit) {
        val code = nextPermissionCode++
        permissionCallbacks[code] = done
        requestPermissions(permissions.toTypedArray(), code)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        permissionCallbacks.remove(requestCode)?.invoke()
    }

    // --- Life ---------------------------------------------------------------------------------------

    // On screen (started), as opposed to stopped -- or shrunk into picture-in-picture.
    private var visible = false

    override fun onStart() {
        super.onStart()
        visible = true
        ui.resumeTimers()
        browser.resumeActive()
    }

    override fun onStop() {
        super.onStop()
        visible = false
        // Not in picture-in-picture: nothing on screen, nothing needs to run.
        if (!isInPictureInPictureMode) {
            browser.pauseAll()
            ui.pauseTimers()
        }
        store.flush()
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        if (isInPictureInPictureMode) return
        // Back to full size, or the small window was closed -- then Kessel
        // is stopped and the video stops too.
        root.postDelayed({
            if (!visible) {
                exitFullscreen()
                browser.pauseAll()
                ui.pauseTimers()
            }
        }, 300)
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        // In the background, where Android ends apps that hold on to memory:
        // every page but the one you were on sleeps.
        if (level >= ComponentCallbacks2.TRIM_MEMORY_BACKGROUND) browser.sleepExtraTabs(keep = 1)
    }

    override fun onDestroy() {
        store.flush()
        browser.destroyAll()
        ui.destroy()
        super.onDestroy()
    }
}

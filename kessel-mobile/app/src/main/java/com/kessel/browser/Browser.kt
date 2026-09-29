package com.kessel.browser

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.util.Base64
import android.view.PixelCopy
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.net.http.SslError
import android.widget.FrameLayout
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import org.json.JSONArray
import org.json.JSONObject

// The tabs: each one's WebView, what it's showing, and everything a page
// can ask of the browser (new windows, fullscreen, permissions, files,
// downloads). The UI (assets/ui) hears about every change as a "tabs" or
// "tab" event and acts through the Bridge.
class Browser(private val activity: MainActivity, private val store: Store, private val shields: Shields) {
    companion object {
        // Private tabs' own cookies, storage and cache (a WebView profile),
        // wiped when the last private tab closes.
        const val PRIVATE_PROFILE = "kessel-private"
        private const val MAX_CLOSED = 25
    }

    val tabs = ArrayList<Tab>()
    var active: Tab? = null
        private set
    private var nextId = 1
    private val closed = ArrayList<JSONObject>()
    private val main = Handler(Looper.getMainLooper())
    private var baseUserAgent: String? = null
    private var blockedEmitPending = false

    // Private tabs need WebView's profiles (a recent WebView); without them
    // Kessel doesn't offer private tabs at all rather than pretend.
    val privateSupported: Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)

    fun find(id: Int) = tabs.find { it.id == id }

    fun bookmarked(tab: Tab) = !tab.private && tab.url.isNotEmpty() && store.isBookmarked(tab.url)

    // --- Opening, switching, closing -----------------------------------------------

    fun newTab(url: String, private: Boolean, foreground: Boolean, opener: Tab? = null, withWebView: Boolean = false): Tab {
        val tab = Tab(nextId++, private && privateSupported)
        tab.desktop = store.bool("desktop_site")
        tab.openerId = opener?.id
        val at = opener?.let { tabs.indexOf(it) + 1 + tabs.drop(tabs.indexOf(it) + 1).takeWhile { t -> t.openerId == it.id }.size } ?: tabs.size
        tabs.add(at.coerceIn(0, tabs.size), tab)
        if (url.isNotEmpty()) load(tab, url) else if (withWebView) wake(tab)
        if (foreground || active == null) activate(tab) else {
            sleepExtraTabs()
            emitTabs()
        }
        return tab
    }

    fun activate(tab: Tab) {
        val previous = active
        if (previous != null && previous !== tab) previous.webView?.let { it.onPause() }
        active = tab
        tab.lastActive = System.currentTimeMillis()
        if (tab.asleep || (tab.crashed && tab.url.isNotEmpty())) {
            tab.crashed = false
            wake(tab)
        }
        tab.webView?.onResume()
        activity.showPage(tab.webView)
        sleepExtraTabs()
        emitTabs()
    }

    fun close(tab: Tab) {
        val index = tabs.indexOf(tab)
        if (index < 0) return
        if (!tab.private && tab.url.isNotEmpty()) {
            closed.add(JSONObject().put("url", tab.url).put("title", tab.title))
            if (closed.size > MAX_CLOSED) closed.removeAt(0)
        }
        tabs.removeAt(index)
        destroyWebView(tab)
        if (tab.private && tabs.none { it.private }) clearPrivateData()
        if (active === tab) {
            active = null
            val next = tab.openerId?.let { find(it) }
                ?: tabs.filter { it.private == tab.private }.let { same -> same.getOrNull(minOf(index, same.size - 1)) ?: same.lastOrNull() }
                ?: tabs.lastOrNull()
            if (next != null) activate(next) else newTab("", false, true)
        } else {
            emitTabs()
        }
    }

    fun closeAll(private: Boolean?) {
        tabs.filter { private == null || it.private == private }.forEach { close(it) }
    }

    fun reopenClosed(): Tab? {
        val last = closed.removeLastOrNull() ?: return null
        return newTab(last.getString("url"), false, true)
    }

    fun closedCount() = closed.size

    // Goes to `url` in `tab` (Shields removes tracking parameters first).
    fun load(tab: Tab, url: String) {
        val clean = if (store.bool("adblock_enabled") && store.bool("shields_strip_tracking")) UrlTools.stripTracking(url) else url
        val existing = tab.webView
        tab.url = clean
        tab.state = null
        tab.errorUrl = null
        tab.crashed = false
        // A new WebView loads tab.url itself.
        val wv = existing ?: wake(tab)
        if (existing != null) wv.loadUrl(clean)
        if (tab === active) activity.showPage(wv)
        emitTab(tab)
    }

    fun goBack(tab: Tab): Boolean {
        val wv = tab.webView
        if (wv != null && wv.canGoBack()) {
            wv.goBack()
            return true
        }
        // Back from the first page of a tab a link opened: back to that tab.
        val opener = tab.openerId?.let { find(it) }
        if (opener != null) {
            close(tab)
            activate(opener)
            return true
        }
        return false
    }

    fun setDesktop(tab: Tab, on: Boolean) {
        tab.desktop = on
        tab.webView?.let {
            applyUserAgent(tab, it.settings)
            it.reload()
        }
        emitTab(tab)
    }

    // --- Sleeping and waking ---------------------------------------------------------

    private fun wake(tab: Tab): WebView {
        tab.webView?.let { return it }
        val wv = createWebView(tab)
        tab.webView = wv
        val saved = tab.state
        tab.state = null
        tab.errorUrl = null
        if (saved != null) wv.restoreState(saved) else if (tab.url.isNotEmpty()) wv.loadUrl(tab.url)
        return wv
    }

    private fun sleep(tab: Tab) {
        val wv = tab.webView ?: return
        if (tab.url.isEmpty()) return
        tab.state = Bundle().also { wv.saveState(it) }
        destroyWebView(tab)
        emitTab(tab)
    }

    // Keeps at most max_awake_tabs pages alive; the ones you looked at
    // longest ago go to sleep.
    fun sleepExtraTabs(keep: Int = store.int("max_awake_tabs").coerceAtLeast(1)) {
        val awake = tabs.filter { it.webView != null && it !== active && it.url.isNotEmpty() }.sortedBy { it.lastActive }
        val extra = awake.size + 1 - keep
        if (extra > 0) awake.take(extra).forEach { sleep(it) }
    }

    private fun destroyWebView(tab: Tab) {
        val wv = tab.webView ?: return
        tab.webView = null
        (wv.parent as? ViewGroup)?.removeView(wv)
        wv.stopLoading()
        if (tab.private && tabs.none { it.private && it.webView != null }) wv.clearCache(true)
        wv.destroy()
    }

    fun destroyAll() = tabs.forEach { destroyWebView(it) }

    fun pauseAll() = tabs.forEach { it.webView?.onPause() }

    fun resumeActive() = active?.webView?.onResume()

    // --- Private tabs ------------------------------------------------------------------

    fun cookieManager(tab: Tab?): CookieManager =
        if (tab?.private == true && privateSupported) ProfileStore.getInstance().getOrCreateProfile(PRIVATE_PROFILE).cookieManager
        else CookieManager.getInstance()

    fun clearPrivateData() {
        if (!privateSupported) return
        val profile = ProfileStore.getInstance().getOrCreateProfile(PRIVATE_PROFILE)
        profile.cookieManager.removeAllCookies(null)
        profile.webStorage.deleteAllData()
        profile.geolocationPermissions.clearAll()
    }

    // --- The WebView ------------------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(tab: Tab): WebView {
        if (tab.private) ProfileStore.getInstance().getOrCreateProfile(PRIVATE_PROFILE)
        val wv = WebView(activity)
        if (tab.private) WebViewCompat.setProfile(wv, PRIVATE_PROFILE)
        wv.layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        val s = wv.settings
        if (baseUserAgent == null) baseUserAgent = UrlTools.browserUserAgent(s.userAgentString)
        s.javaScriptEnabled = store.bool("javascript")
        s.domStorageEnabled = true
        s.loadWithOverviewMode = true
        s.useWideViewPort = true
        s.builtInZoomControls = true
        s.displayZoomControls = false
        s.setSupportZoom(true)
        s.setSupportMultipleWindows(true)
        s.javaScriptCanOpenWindowsAutomatically = true
        s.mediaPlaybackRequiresUserGesture = true
        s.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        s.allowFileAccess = false
        s.textZoom = store.int("text_zoom").coerceIn(50, 300)
        if (Build.VERSION.SDK_INT >= 33) s.isAlgorithmicDarkeningAllowed = store.bool("dark_pages")
        applyUserAgent(tab, s)
        cookieManager(tab).setAcceptThirdPartyCookies(wv, store.bool("third_party_cookies"))
        wv.webViewClient = PageClient(tab)
        wv.webChromeClient = ChromeClient(tab)
        wv.setDownloadListener { url, userAgent, disposition, mime, length ->
            activity.downloads.start(tab, url, userAgent, disposition, mime, length)
        }
        wv.setOnLongClickListener { longPress(tab, wv) }
        wv.setFindListener { activeMatch, count, done ->
            if (done && tab === active) activity.emit("find", JSONObject().put("active", if (count > 0) activeMatch + 1 else 0).put("count", count))
        }
        return wv
    }

    private fun applyUserAgent(tab: Tab, s: WebSettings) {
        val base = baseUserAgent ?: return
        s.userAgentString = if (tab.desktop) UrlTools.desktopUserAgent(base) else base
    }

    // Settings -> ... changed: every open page follows.
    fun applySettings() {
        shields.enabled = store.bool("adblock_enabled")
        shields.offSites = store.offSites()
        for (tab in tabs) {
            val wv = tab.webView ?: continue
            val s = wv.settings
            s.javaScriptEnabled = store.bool("javascript")
            s.textZoom = store.int("text_zoom").coerceIn(50, 300)
            if (Build.VERSION.SDK_INT >= 33) s.isAlgorithmicDarkeningAllowed = store.bool("dark_pages")
            cookieManager(tab).setAcceptThirdPartyCookies(wv, store.bool("third_party_cookies"))
        }
    }

    // --- What pages do ------------------------------------------------------------------------

    private inner class PageClient(private val tab: Tab) : WebViewClient() {
        // The address a link is taking the tab to, before the page starts.
        private var navigating: String? = null

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            when (request.url.scheme?.lowercase()) {
                "http", "https" -> {
                    if (request.isForMainFrame && !request.isRedirect && store.bool("adblock_enabled") && store.bool("shields_strip_tracking")) {
                        val clean = UrlTools.stripTracking(url)
                        if (clean != url) {
                            navigating = clean
                            view.loadUrl(clean)
                            return true
                        }
                    }
                    if (request.isForMainFrame) navigating = url
                    return false
                }
                "about", "data", "javascript", "blob" -> return false
                "file", "content" -> return true
                // mailto:, tel:, intent:, market:, an app's own links...
                else -> {
                    if (request.isForMainFrame) activity.openExternal(url, request.hasGesture(), view)
                    return true
                }
            }
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            navigating = null
            tab.url = url
            tab.loading = true
            tab.crashed = false
            tab.pageHost = UrlTools.hostOf(url)
            tab.blocked.set(0)
            tab.favicon = store.favicons.optString(UrlTools.hostOf(url))
            emitTab(tab)
        }

        override fun onPageFinished(view: WebView, url: String) {
            tab.loading = false
            tab.progress = 100
            tab.canBack = view.canGoBack()
            tab.canForward = view.canGoForward()
            view.title?.takeIf { it.isNotBlank() && !it.startsWith("data:") }?.let { tab.title = it }
            if (!tab.private && url == tab.url) store.titleVisit(url, tab.title)
            emitTab(tab)
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
            tab.url = url
            tab.pageHost = UrlTools.hostOf(url)
            tab.canBack = view.canGoBack()
            tab.canForward = view.canGoForward()
            if (url == tab.errorUrl) {
                tab.errorUrl = null
            } else if (!tab.private && !isReload) {
                store.recordVisit(url, view.title ?: "")
            }
            emitTab(tab)
        }

        // Shields: ad and tracking servers never get the request.
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            if (request.isForMainFrame) return null
            val host = request.url.host?.lowercase() ?: return null
            if (!shields.shouldBlock(host, tab.pageHost)) return null
            tab.blocked.incrementAndGet()
            main.post { emitBlockedSoon() }
            return WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            val description = error.description?.toString() ?: ""
            if (description.contains("ERR_ABORTED")) return
            showError(view, request.url.toString(), friendlyError(error.errorCode, description), description)
        }

        @SuppressLint("WebViewClientOnReceivedSslError")
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            // Never proceed past a bad certificate: say why instead.
            handler.cancel()
            // Only the page itself gets the warning; a broken picture on it doesn't.
            if (error.url == tab.url || error.url == navigating) {
                showError(view, error.url, "This connection isn't private: the site's certificate can't be trusted, so someone could be listening in.", "Certificate error ${error.primaryError}")
            }
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // The page crashed (or Android reclaimed its memory): the tab
            // stays, and loads again when you come back to it.
            val owner = tabs.find { it.webView === view } ?: tab
            owner.webView = null
            (view.parent as? ViewGroup)?.removeView(view)
            view.destroy()
            owner.crashed = true
            owner.loading = false
            if (owner === active) activity.showPage(null)
            emitTab(owner)
            return true
        }
    }

    private fun friendlyError(code: Int, description: String): String = when (code) {
        WebViewClient.ERROR_HOST_LOOKUP -> "Kessel couldn't find this site. Check the address, or your connection."
        WebViewClient.ERROR_CONNECT, WebViewClient.ERROR_TIMEOUT -> "The site didn't answer. It may be down, or you may be offline."
        WebViewClient.ERROR_FAILED_SSL_HANDSHAKE -> "A secure connection to the site couldn't be made."
        WebViewClient.ERROR_UNSUPPORTED_SCHEME -> "Kessel can't open this kind of address."
        else -> if (description.contains("INTERNET_DISCONNECTED")) "You're offline. Connect to the internet and try again." else "This page couldn't be loaded."
    }

    private fun showError(view: WebView, url: String, message: String, detail: String) {
        val tab = tabs.find { it.webView === view } ?: return
        tab.errorUrl = url
        tab.loading = false
        val esc = { s: String -> s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;") }
        val dark = activity.isDarkUi()
        val html = """<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(UrlTools.hostOf(url))}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:15vh 28px;background:${if (dark) "#0b0c10" else "#f4f5f8"};color:${if (dark) "#eceef4" else "#191a23"}}
h1{font-size:22px;margin:0 0 12px}p{line-height:1.5;opacity:.8}small{opacity:.5;word-break:break-all}
a{display:inline-block;margin-top:22px;padding:12px 22px;border-radius:12px;background:#7c5cff;color:#fff;text-decoration:none;font-weight:600}</style></head>
<body><h1>Can't open this page</h1><p>${esc(message)}</p><small>${esc(url)} · ${esc(detail)}</small><br>
<a href="${esc(url)}">Try again</a></body></html>"""
        view.loadDataWithBaseURL(url, html, "text/html", "utf-8", url)
    }

    private inner class ChromeClient(private val tab: Tab) : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            tab.progress = newProgress
            emitTab(tab)
        }

        override fun onReceivedTitle(view: WebView, title: String?) {
            if (title.isNullOrBlank() || title.startsWith("data:")) return
            tab.title = title
            if (!tab.private && tab.errorUrl == null) store.titleVisit(tab.url, title)
            emitTab(tab)
        }

        override fun onReceivedIcon(view: WebView, icon: Bitmap?) {
            icon ?: return
            val data = iconDataUrl(icon)
            tab.favicon = data
            if (!tab.private) store.setFavicon(UrlTools.hostOf(tab.url), data)
            emitTab(tab)
        }

        // window.open and target=_blank: a new tab -- unless a page opens it
        // without you tapping anything (a pop-up), which Kessel blocks.
        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            if (!isUserGesture && store.bool("block_popups")) {
                activity.toast("Pop-up blocked")
                return false
            }
            val child = newTab("", tab.private, foreground = true, opener = tab, withWebView = true)
            val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
            transport.webView = child.webView
            resultMsg.sendToTarget()
            return true
        }

        override fun onCloseWindow(window: WebView) {
            tabs.find { it.webView === window }?.let { close(it) }
        }

        override fun onShowCustomView(view: View, callback: CustomViewCallback) = activity.enterFullscreen(view, callback)

        override fun onHideCustomView() = activity.exitFullscreen()

        override fun onPermissionRequest(request: PermissionRequest) = activity.permissions.onWebRequest(tab, request)

        override fun onPermissionRequestCanceled(request: PermissionRequest) = activity.permissions.cancel(request)

        override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) =
            activity.permissions.onGeolocation(tab, origin, callback)

        override fun onShowFileChooser(webView: WebView, filePathCallback: ValueCallback<Array<Uri>>, fileChooserParams: FileChooserParams): Boolean =
            activity.chooseFiles(filePathCallback, fileChooserParams)

        // No grey "play" poster on videos that haven't loaded one.
        override fun getDefaultVideoPoster(): Bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
    }

    private fun iconDataUrl(icon: Bitmap): String {
        val size = 48
        val scaled = if (icon.width > size) Bitmap.createScaledBitmap(icon, size, size * icon.height / icon.width.coerceAtLeast(1), true) else icon
        val out = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.PNG, 100, out)
        return "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    // --- Long press: the link / image menu -------------------------------------------------

    // What was long-pressed last, for the menu's actions (Bridge "context.action").
    var pressed: JSONObject? = null
        private set

    private fun longPress(tab: Tab, wv: WebView): Boolean {
        val hit = wv.hitTestResult
        val extra = hit.extra ?: return false
        when (hit.type) {
            WebView.HitTestResult.SRC_ANCHOR_TYPE, WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE -> {
                val isImage = hit.type == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE
                val handler = Handler(Looper.getMainLooper()) { m ->
                    val link = m.data.getString("url")?.takeIf { it.isNotEmpty() } ?: if (isImage) "" else extra
                    val text = m.data.getString("title") ?: ""
                    showContextMenu(tab, if (isImage) "image-link" else "link", link, text, if (isImage) extra else "")
                    true
                }
                wv.requestFocusNodeHref(handler.obtainMessage())
            }
            WebView.HitTestResult.IMAGE_TYPE -> showContextMenu(tab, "image", "", "", extra)
            else -> return false
        }
        return true
    }

    private fun showContextMenu(tab: Tab, kind: String, link: String, text: String, image: String) {
        pressed = JSONObject().put("tab", tab.id).put("kind", kind).put("url", link).put("text", text).put("image", image)
        // Huge data: images stay here; the menu shows a short version.
        val shown = JSONObject().put("kind", kind).put("url", link).put("text", text.take(300))
            .put("image", if (image.length > 2048) image.take(64) + "…" else image)
            .put("private", tab.private).put("privateSupported", privateSupported)
        activity.emit("context", shown)
    }

    // --- Tab pictures, for the tab switcher ----------------------------------------------------

    // A picture of the page on screen now (the active tab's), then `done`.
    fun captureActive(done: () -> Unit) {
        val tab = active
        val wv = tab?.webView
        if (tab == null || wv == null || wv.width == 0 || wv.height == 0 || !wv.isAttachedToWindow) {
            done()
            return
        }
        val location = IntArray(2)
        wv.getLocationInWindow(location)
        val rect = Rect(location[0], location[1], location[0] + wv.width, location[1] + wv.height)
        val width = 360
        val height = (width.toFloat() * wv.height / wv.width).toInt().coerceIn(1, 1200)
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        try {
            PixelCopy.request(activity.window, rect, bitmap, { result ->
                if (result == PixelCopy.SUCCESS) {
                    val out = ByteArrayOutputStream()
                    bitmap.compress(Bitmap.CompressFormat.JPEG, 70, out)
                    tab.thumbnail = "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                }
                done()
            }, main)
        } catch (e: IllegalArgumentException) {
            done()
        }
    }

    fun thumbnails(): JSONObject {
        val out = JSONObject()
        for (tab in tabs) if (tab.thumbnail.isNotEmpty()) out.put(tab.id.toString(), tab.thumbnail)
        return out
    }

    // --- Telling the UI ------------------------------------------------------------------------------

    fun tabsJson(): JSONArray {
        val list = JSONArray()
        for (tab in tabs) list.put(tab.json(bookmarked(tab)))
        return list
    }

    fun emitTabs() {
        activity.emit("tabs", JSONObject().put("tabs", tabsJson()).put("active", active?.id ?: 0).put("closed", closed.size))
        saveSession()
    }

    fun emitTab(tab: Tab) {
        activity.emit("tab", tab.json(bookmarked(tab)).put("active", tab === active))
        if (!tab.private) saveSession()
    }

    // Shields counts come in fast (a page can make hundreds of requests):
    // one update every half second at most.
    private fun emitBlockedSoon() {
        if (blockedEmitPending) return
        blockedEmitPending = true
        main.postDelayed({
            blockedEmitPending = false
            active?.let { activity.emit("blocked", JSONObject().put("id", it.id).put("count", it.blocked.get())) }
        }, 500)
    }

    // --- The tabs you had open, for next time ---------------------------------------------------------

    private fun saveSession() {
        val list = JSONArray()
        var activeIndex = 0
        for (tab in tabs) {
            if (tab.private || tab.url.isEmpty()) continue
            if (tab === active) activeIndex = list.length()
            list.put(JSONObject().put("url", tab.errorUrl ?: tab.url).put("title", tab.title).put("favicon", tab.favicon))
        }
        store.saveSession(JSONObject().put("tabs", list).put("active", activeIndex))
    }

    // At start: your tabs from last time, asleep except the one you were on.
    fun restore() {
        clearPrivateData()
        val session = if (store.bool("restore_tabs")) store.session() else null
        val list = session?.optJSONArray("tabs")
        if (list == null || list.length() == 0) {
            newTab("", false, true)
            return
        }
        for (i in 0 until list.length()) {
            val saved = list.getJSONObject(i)
            val tab = Tab(nextId++, false)
            tab.url = saved.optString("url")
            tab.title = saved.optString("title")
            tab.favicon = saved.optString("favicon")
            tab.desktop = store.bool("desktop_site")
            tab.pageHost = UrlTools.hostOf(tab.url)
            tabs.add(tab)
        }
        activate(tabs[session.optInt("active").coerceIn(0, tabs.size - 1)])
    }
}

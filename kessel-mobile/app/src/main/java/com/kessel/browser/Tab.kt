package com.kessel.browser

import android.os.Bundle
import android.webkit.WebView
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONObject

// One tab: a page in its own WebView -- or, while it sleeps, just its
// address and back/forward list (the desktop's sleeping tabs), so a phone
// with twenty tabs open only keeps a few pages in memory.
class Tab(val id: Int, val private: Boolean) {
    var webView: WebView? = null
    // "" = the new tab page (Kessel's own, drawn by the UI; no WebView).
    var url = ""
    var title = ""
    var favicon = ""
    var progress = 100
    var loading = false
    var canBack = false
    var canForward = false
    // "Desktop site": the page gets a desktop browser's user agent.
    var desktop = false
    // An asleep tab's back/forward list (WebView.saveState).
    var state: Bundle? = null
    var lastActive = System.currentTimeMillis()
    // A small picture of the page, for the tab switcher (data URL).
    var thumbnail = ""
    // The tab whose link opened this one: Back from its first page returns there.
    var openerId: Int? = null
    var crashed = false
    // The address Kessel's own error page stands for (not a visit).
    var errorUrl: String? = null

    // Read on the engine's network thread (Shields).
    @Volatile var pageHost = ""
    val blocked = AtomicInteger()

    val asleep get() = webView == null && url.isNotEmpty()

    fun json(bookmarked: Boolean): JSONObject = JSONObject()
        .put("id", id)
        .put("url", url)
        .put("title", title)
        .put("favicon", favicon)
        .put("private", private)
        .put("loading", loading)
        .put("progress", progress)
        .put("canBack", canBack || openerId != null)
        .put("canForward", canForward)
        .put("desktop", desktop)
        .put("blocked", blocked.get())
        .put("asleep", asleep)
        .put("crashed", crashed)
        .put("secure", url.startsWith("https://"))
        .put("bookmarked", bookmarked)
}

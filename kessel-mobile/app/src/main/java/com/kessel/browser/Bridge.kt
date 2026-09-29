package com.kessel.browser

import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebStorage
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject

// How Kessel's UI (assets/ui, in its own WebView) reaches the browser:
// KesselNative.post('{"id":1,"cmd":"tabs.new","args":{...}}'), answered with
// window.__kesselReply(id, ok, value). Only the UI's WebView has it -- web
// pages never do -- and it's checked to still be showing Kessel's own UI
// before every command.
class Bridge(private val activity: MainActivity) {
    private object Async

    private val browser get() = activity.browser
    private val store get() = activity.store

    @JavascriptInterface
    fun post(message: String) {
        activity.runOnUiThread { handle(message) }
    }

    private fun handle(message: String) {
        if (!activity.isUiShowingKessel()) return
        val m = runCatching { JSONObject(message) }.getOrNull() ?: return
        val id = m.optInt("id")
        val args = m.optJSONObject("args") ?: JSONObject()
        try {
            val result = dispatch(m.optString("cmd"), args, id)
            if (result !== Async) reply(id, true, result)
        } catch (e: Exception) {
            reply(id, false, e.message ?: e.toString())
        }
    }

    fun reply(id: Int, ok: Boolean, value: Any?) {
        activity.runJs("window.__kesselReply($id,$ok,${json(value)})")
    }

    // Runs `work` off the main thread, then answers with its result.
    private fun later(id: Int, work: () -> Any?): Any {
        Net.pool.execute {
            val value = runCatching(work).getOrNull()
            activity.runOnUiThread { reply(id, true, value) }
        }
        return Async
    }

    private fun tab(args: JSONObject): Tab? = if (args.has("id")) browser.find(args.getInt("id")) else browser.active

    private fun dispatch(cmd: String, a: JSONObject, id: Int): Any? = when (cmd) {
        "ready" -> activity.uiReady()

        // --- Settings ---
        "settings.set" -> {
            store.updateSettings(a.getJSONObject("patch"))
            browser.applySettings()
            activity.applyTheme()
            store.settings
        }

        // --- Tabs ---
        "tabs.new" -> browser.newTab(a.optString("url"), a.optBoolean("private"), !a.optBoolean("background"), if (a.optBoolean("fromActive")) browser.active else null).id
        "tabs.activate" -> browser.find(a.getInt("id"))?.let { browser.activate(it) }
        "tabs.close" -> browser.find(a.getInt("id"))?.let { browser.close(it) }
        "tabs.closeAll" -> browser.closeAll(if (a.has("private")) a.getBoolean("private") else null)
        "tabs.reopen" -> browser.reopenClosed()?.id
        "tabs.capture" -> {
            browser.captureActive { reply(id, true, true) }
            Async
        }
        "tabs.thumbnails" -> browser.thumbnails()

        // --- The page ---
        "nav.go" -> tab(a)?.let { browser.load(it, a.getString("url")) }
        "nav.back" -> tab(a)?.let { browser.goBack(it) }
        "nav.forward" -> tab(a)?.webView?.goForward()
        "nav.reload" -> tab(a)?.let { t -> t.webView?.reload() ?: browser.activate(t) }
        "nav.stop" -> tab(a)?.webView?.stopLoading()
        "find.start" -> browser.active?.webView?.findAllAsync(a.getString("text"))
        "find.next" -> browser.active?.webView?.findNext(a.optBoolean("forward", true))
        "find.clear" -> browser.active?.webView?.clearMatches()
        "page.desktop" -> tab(a)?.let { browser.setDesktop(it, a.getBoolean("on")) }
        "page.share" -> activity.share(a.optString("url").ifEmpty { browser.active?.url ?: "" }, a.optString("title").ifEmpty { browser.active?.title ?: "" })
        "page.print" -> browser.active?.let { activity.print(it) }
        "page.addToHome" -> browser.active?.let { activity.addToHomeScreen(it) }
        "page.copy" -> activity.copy(a.getString("text"))
        "context.action" -> contextAction(a.getString("action"))

        // --- The UI itself ---
        "ui.mode" -> activity.setUiMode(a.getString("mode"), a.optInt("height", 56), a.optString("position", "bottom"))
        "ui.colors" -> activity.setBarColors(a.getString("bg"), a.getBoolean("dark"))

        // --- Bookmarks ---
        "bookmarks.list" -> store.bookmarks
        "bookmarks.add" -> store.addBookmark(a.getString("url"), a.optString("title")).also { refreshActive() }
        "bookmarks.remove" -> store.removeBookmark(a.getString("url")).also { refreshActive() }
        "bookmarks.rename" -> store.renameBookmark(a.getString("url"), a.getString("title"))

        // --- History ---
        "history.suggest" -> store.historyForSuggestions()
        "history.page" -> store.historyPage(a.optString("q"), a.optInt("offset"), a.optInt("limit", 100))
        "history.remove" -> store.removeVisit(a.getString("url"))
        "history.removeSite" -> store.removeSite(a.getString("host"))
        "favicons.get" -> {
            val hosts = a.getJSONArray("hosts")
            val out = JSONObject()
            for (i in 0 until hosts.length()) store.favicons.optString(hosts.getString(i)).takeIf { it.isNotEmpty() }?.let { out.put(hosts.getString(i), it) }
            out
        }

        // --- The address bar's answers ---
        "net.suggest" -> later(id) { JSONArray(Net.suggest(a.getString("engine"), a.getString("text"))) }
        "net.rates" -> later(id) { Net.rates(activity.filesDir) }
        "net.define" -> later(id) { Net.define(a.getString("word")) }

        // --- Downloads ---
        "downloads.list" -> activity.downloads.list()
        "downloads.open" -> activity.downloads.open(a.getString("key"))
        "downloads.remove" -> activity.downloads.remove(a.getString("key"))
        "downloads.clear" -> activity.downloads.clearList()

        // --- Privacy ---
        "data.clear" -> clearData(a)
        "shields.site" -> {
            val host = a.getString("host").removePrefix("www.")
            val sites = store.offSites().toMutableSet()
            if (a.getBoolean("on")) sites.remove(host) else sites.add(host)
            store.updateSettings(JSONObject().put("shields_off_sites", JSONArray(sites.sorted())))
            browser.applySettings()
            browser.active?.webView?.reload()
            store.settings
        }
        "shields.info" -> JSONObject().put("rules", activity.shields.ruleCount).put("updated", activity.shields.updatedAt)
            .put("lists", JSONArray(Shields.LISTS.map { it.name }))
        "shields.update" -> {
            activity.shields.update { count -> activity.runOnUiThread { reply(id, true, count) } }
            Async
        }
        "permissions.answer" -> activity.permissions.answer(a.getInt("id"), a.getBoolean("allow"), a.optBoolean("remember"))
        "permissions.list" -> activity.permissions.list()
        "permissions.reset" -> store.resetPermissions(a.optString("host").ifEmpty { null })

        // --- Kessel ---
        "app.defaultBrowser" -> activity.requestDefaultBrowser()
        "app.info" -> activity.appInfo()
        "app.toast" -> activity.toast(a.getString("text"))
        else -> throw IllegalArgumentException("unknown command $cmd")
    }

    private fun refreshActive() {
        browser.active?.let { browser.emitTab(it) }
    }

    private fun contextAction(action: String): Any? {
        val p = browser.pressed ?: return null
        val from = browser.find(p.optInt("tab"))
        val private = from?.private ?: false
        val url = p.optString("url")
        val image = p.optString("image")
        when (action) {
            "open-new" -> browser.newTab(url, private, true, from)
            "open-background" -> {
                browser.newTab(url, private, false, from)
                activity.toast("Opened in a new tab")
            }
            "open-private" -> browser.newTab(url, true, true)
            "copy-link" -> activity.copy(url)
            "copy-text" -> activity.copy(p.optString("text"))
            "share-link" -> activity.share(url, p.optString("text"))
            "download-link" -> activity.downloads.startUrl(from, url)
            "open-image" -> browser.newTab(image, private, true, from)
            "copy-image-address" -> activity.copy(image)
            "download-image" -> activity.downloads.startUrl(from, image)
            "share-image" -> activity.share(image, "")
        }
        return null
    }

    // Settings -> Clear browsing data. `since`: seconds since 1970 (0 = all time).
    private fun clearData(a: JSONObject): Any? {
        val since = a.optLong("since")
        if (a.optBoolean("history")) {
            store.clearHistory(since)
            browser.tabs.forEach { it.webView?.clearHistory() }
        }
        if (a.optBoolean("cookies")) {
            CookieManager.getInstance().removeAllCookies(null)
            CookieManager.getInstance().flush()
            WebStorage.getInstance().deleteAllData()
            store.resetPermissions(null)
        }
        if (a.optBoolean("cache")) {
            val any = browser.tabs.firstOrNull { it.webView != null && !it.private }?.webView
            if (any != null) any.clearCache(true) else WebView(activity).apply { clearCache(true); destroy() }
        }
        if (a.optBoolean("downloads")) activity.downloads.clearList()
        return true
    }

    companion object {
        fun json(value: Any?): String = when (value) {
            null, Unit -> "null"
            is JSONObject, is JSONArray -> value.toString()
            is String -> JSONObject.quote(value)
            is Boolean, is Int, is Long -> value.toString()
            is Double -> if (value.isFinite()) value.toString() else "null"
            is Float -> if (value.isFinite()) value.toString() else "null"
            else -> JSONObject.quote(value.toString())
        }
    }
}

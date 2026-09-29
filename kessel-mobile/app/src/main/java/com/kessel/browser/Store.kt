package com.kessel.browser

import android.os.Handler
import android.os.Looper
import java.io.File
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

// Everything Kessel keeps, as JSON files in the app's own storage, like the
// desktop's settings.json / bookmarks / history: settings, bookmarks,
// history, site icons, site permissions, downloads and the open tabs.
// Used from the main thread only; files are written a moment after a change,
// off the main thread.
class Store(private val dir: File) {
    companion object {
        // Names follow the desktop's settings where they mean the same.
        fun defaults(): JSONObject = JSONObject()
            .put("search_engine", "google")
            .put("search_suggestions", true)
            .put("address_answers", true)
            .put("autocomplete_addresses", true)
            .put("theme", "system") // "system" | "dark" | "light"
            .put("bar_position", "bottom") // the address bar: "bottom" | "top"
            .put("adblock_enabled", true)
            .put("shields_strip_tracking", true)
            .put("shields_off_sites", JSONArray())
            .put("restore_tabs", true)
            .put("desktop_site", false)
            .put("text_zoom", 100)
            .put("dark_pages", true)
            .put("block_popups", true)
            .put("javascript", true)
            .put("third_party_cookies", false)
            .put("max_awake_tabs", 6)
            .put("history_days", 90)

        const val HISTORY_LIMIT = 5000
    }

    class Visit(val url: String, var title: String, var visits: Int, var last: Long)

    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    // File name -> what to write there, for the writes waiting to happen.
    private val pending = LinkedHashMap<String, () -> String>()

    val settings: JSONObject = defaults()
    var bookmarks = JSONArray()
        private set
    val history = ArrayList<Visit>()
    private val historyIndex = HashMap<String, Visit>()
    val favicons = JSONObject()
    val permissions = JSONObject()
    var downloads = JSONArray()
        private set

    init {
        dir.mkdirs()
        read("settings.json")?.let { JSONObject(it) }?.let { saved -> saved.keys().forEach { settings.put(it, saved.get(it)) } }
        read("bookmarks.json")?.let { bookmarks = JSONArray(it) }
        read("history.json")?.let {
            val list = JSONArray(it)
            for (i in 0 until list.length()) {
                val v = list.getJSONArray(i)
                val visit = Visit(v.getString(0), v.optString(1), v.optInt(2, 1), v.optLong(3))
                history.add(visit)
                historyIndex[visit.url] = visit
            }
        }
        read("favicons.json")?.let { saved -> JSONObject(saved).let { f -> f.keys().forEach { favicons.put(it, f.get(it)) } } }
        read("permissions.json")?.let { saved -> JSONObject(saved).let { p -> p.keys().forEach { permissions.put(it, p.get(it)) } } }
        read("downloads.json")?.let { downloads = JSONArray(it) }
        forgetOldHistory()
    }

    private fun read(name: String): String? = runCatching { File(dir, name).takeIf { it.exists() }?.readText() }.getOrNull()

    // Writes `name` half a second after the first of a burst of changes to it.
    private fun save(name: String, content: () -> String) {
        val waiting = pending.containsKey(name)
        pending[name] = content
        if (!waiting) main.postDelayed({ write(name) }, 500)
    }

    private fun write(name: String) {
        val content = pending.remove(name) ?: return
        val text = content()
        io.execute {
            val tmp = File(dir, "$name.tmp")
            tmp.writeText(text)
            tmp.renameTo(File(dir, name))
        }
    }

    // Now, not in a moment: Kessel is going to the background, where Android may end it.
    fun flush() = pending.keys.toList().forEach { write(it) }

    // --- Settings ---

    fun setting(key: String): Any? = settings.opt(key)
    fun bool(key: String) = settings.optBoolean(key)
    fun string(key: String) = settings.optString(key)
    fun int(key: String) = settings.optInt(key)

    fun updateSettings(patch: JSONObject) {
        patch.keys().forEach { settings.put(it, patch.get(it)) }
        save("settings.json") { settings.toString() }
    }

    fun offSites(): Set<String> {
        val list = settings.optJSONArray("shields_off_sites") ?: return emptySet()
        return (0 until list.length()).map { list.getString(it) }.toSet()
    }

    // --- Bookmarks: [{ url, title, added }], newest first ---

    fun isBookmarked(url: String) = (0 until bookmarks.length()).any { bookmarks.getJSONObject(it).optString("url") == url }

    fun addBookmark(url: String, title: String) {
        if (url.isEmpty() || isBookmarked(url)) return
        val list = JSONArray().put(JSONObject().put("url", url).put("title", title).put("added", now()))
        for (i in 0 until bookmarks.length()) list.put(bookmarks.get(i))
        bookmarks = list
        save("bookmarks.json") { bookmarks.toString() }
    }

    fun removeBookmark(url: String) {
        val list = JSONArray()
        for (i in 0 until bookmarks.length()) bookmarks.getJSONObject(i).let { if (it.optString("url") != url) list.put(it) }
        bookmarks = list
        save("bookmarks.json") { bookmarks.toString() }
    }

    fun renameBookmark(url: String, title: String) {
        for (i in 0 until bookmarks.length()) bookmarks.getJSONObject(i).let { if (it.optString("url") == url) it.put("title", title) }
        save("bookmarks.json") { bookmarks.toString() }
    }

    // --- History ---

    fun now() = System.currentTimeMillis() / 1000

    fun recordVisit(url: String, title: String) {
        if (!url.startsWith("http://") && !url.startsWith("https://")) return
        val visit = historyIndex[url]
        if (visit != null) {
            // The same page again within a minute (a reload, a redirect back) isn't another visit.
            if (now() - visit.last > 60) visit.visits++
            visit.last = now()
            if (title.isNotBlank()) visit.title = title
            history.remove(visit)
            history.add(visit)
        } else {
            val v = Visit(url, title, 1, now())
            history.add(v)
            historyIndex[url] = v
            if (history.size > HISTORY_LIMIT) historyIndex.remove(history.removeAt(0).url)
        }
        saveHistory()
    }

    fun titleVisit(url: String, title: String) {
        val visit = historyIndex[url] ?: return
        if (title.isNotBlank() && visit.title != title) {
            visit.title = title
            saveHistory()
        }
    }

    fun removeVisit(url: String) {
        historyIndex.remove(url)?.let { history.remove(it) }
        saveHistory()
    }

    // Every visit to a site ("example.com" -- www. or not).
    fun removeSite(host: String) {
        val bare = host.removePrefix("www.")
        history.removeAll { v -> UrlTools.hostOf(v.url).removePrefix("www.") == bare && historyIndex.remove(v.url) != null }
        saveHistory()
    }

    fun clearHistory(sinceSeconds: Long = 0) {
        history.removeAll { v -> v.last >= sinceSeconds && historyIndex.remove(v.url) != null }
        saveHistory()
    }

    private fun forgetOldHistory() {
        val days = settings.optInt("history_days", 90)
        if (days <= 0) return
        val cutoff = now() - days * 86400L
        history.removeAll { v -> v.last < cutoff && historyIndex.remove(v.url) != null }
    }

    private fun saveHistory() = save("history.json") {
        val list = JSONArray()
        for (v in history) list.put(JSONArray().put(v.url).put(v.title).put(v.visits).put(v.last))
        list.toString()
    }

    // For the address bar and the new tab page: the pages you go to most
    // and lately, best first, as [url, title, visits, last].
    fun historyForSuggestions(limit: Int = 2000): JSONArray {
        val t = now()
        val ranked = history.sortedByDescending { v -> v.visits * 2.0 + 30.0 / (1 + (t - v.last) / 86400.0) }
        val out = JSONArray()
        for (v in ranked.take(limit)) out.put(JSONArray().put(v.url).put(v.title).put(v.visits).put(v.last))
        return out
    }

    // History, newest first, optionally matching every word of `query`.
    fun historyPage(query: String, offset: Int, limit: Int): JSONArray {
        val words = query.lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
        val out = JSONArray()
        var skipped = 0
        for (i in history.indices.reversed()) {
            val v = history[i]
            if (words.isNotEmpty()) {
                val hay = (v.title + " " + v.url).lowercase()
                if (!words.all { hay.contains(it) }) continue
            }
            if (skipped++ < offset) continue
            out.put(JSONObject().put("url", v.url).put("title", v.title).put("visits", v.visits).put("last", v.last))
            if (out.length() >= limit) break
        }
        return out
    }

    // --- Site icons: host -> small PNG data URL ---

    fun setFavicon(host: String, dataUrl: String) {
        if (host.isEmpty() || favicons.optString(host) == dataUrl) return
        favicons.put(host, dataUrl)
        if (favicons.length() > 400) {
            // Forget the ones of sites no longer in history.
            val keep = history.takeLast(1500).map { UrlTools.hostOf(it.url) }.toSet()
            favicons.keys().asSequence().toList().filter { it !in keep }.forEach { favicons.remove(it) }
        }
        save("favicons.json") { favicons.toString() }
    }

    // --- Site permissions: host -> { camera: true/false, microphone, location } ---

    fun permission(host: String, kind: String): Boolean? {
        val site = permissions.optJSONObject(host) ?: return null
        return if (site.has(kind)) site.getBoolean(kind) else null
    }

    fun setPermission(host: String, kind: String, allow: Boolean) {
        val site = permissions.optJSONObject(host) ?: JSONObject().also { permissions.put(host, it) }
        site.put(kind, allow)
        save("permissions.json") { permissions.toString() }
    }

    fun resetPermissions(host: String?) {
        if (host == null) permissions.keys().asSequence().toList().forEach { permissions.remove(it) } else permissions.remove(host)
        save("permissions.json") { permissions.toString() }
    }

    // --- Downloads: [{ key, dm, name, url, mime, time, uri? }], newest first ---

    fun addDownload(entry: JSONObject) {
        val list = JSONArray().put(entry)
        for (i in 0 until minOf(downloads.length(), 199)) list.put(downloads.get(i))
        downloads = list
        save("downloads.json") { downloads.toString() }
    }

    fun removeDownload(key: String) {
        val list = JSONArray()
        for (i in 0 until downloads.length()) downloads.getJSONObject(i).let { if (it.optString("key") != key) list.put(it) }
        downloads = list
        save("downloads.json") { downloads.toString() }
    }

    fun clearDownloads() {
        downloads = JSONArray()
        save("downloads.json") { downloads.toString() }
    }

    // --- The open tabs, for the next start ---

    fun saveSession(session: JSONObject) = save("session.json") { session.toString() }

    fun session(): JSONObject? = read("session.json")?.let { runCatching { JSONObject(it) }.getOrNull() }
}

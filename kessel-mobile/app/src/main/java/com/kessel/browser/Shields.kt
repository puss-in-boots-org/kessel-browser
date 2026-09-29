package com.kessel.browser

import android.content.Context
import java.io.File
import java.util.concurrent.Executors

// Shields on a phone: requests to ad and tracking servers are blocked
// before they leave the phone (MainActivity's shouldInterceptRequest asks
// shouldBlock). The desktop runs Brave's full filter engine; here it's the
// lists' server rules -- "||ads.example^" -- which is where nearly all of
// the blocking happens anyway, matched against the request's host and every
// domain above it. Element hiding and scriptlets are the desktop's only.
//
// The lists come with the app (assets/shields, see
// scripts/fetch-mobile-shields.mjs) and are updated every few days into
// the app's own files.
class Shields(private val context: Context) {
    data class FilterList(val id: String, val name: String, val url: String)

    companion object {
        val LISTS = listOf(
            FilterList("easylist", "EasyList", "https://easylist.to/easylist/easylist.txt"),
            FilterList("easyprivacy", "EasyPrivacy", "https://easylist.to/easylist/easyprivacy.txt"),
            FilterList("peter-lowe", "Peter Lowe's list", "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext"),
        )

        const val MAX_AGE_MS = 4L * 24 * 3600 * 1000

        // Options a server rule may carry and still mean "block this server":
        // which kinds of request, and third-party. Anything else (domain=,
        // redirects, first-party only...) needs the full engine.
        private val SIMPLE_OPTIONS = setOf(
            "third-party", "3p", "script", "image", "stylesheet", "css", "xmlhttprequest", "xhr", "subdocument",
            "frame", "media", "font", "ping", "other", "object", "websocket", "all", "important",
        )

        private val HOST = Regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")

        // Adds a list's server rules to `block` and its exceptions to `allow`.
        // Adblock syntax ("||host^", "||host^$third-party", "@@||host^") and
        // hosts files ("0.0.0.0 host").
        fun parse(text: String, block: MutableSet<String>, allow: MutableSet<String>) {
            for (raw in text.lineSequence()) {
                val line = raw.trim()
                if (line.isEmpty() || line[0] == '!' || line[0] == '[' || line[0] == '#') continue
                if (line.startsWith("0.0.0.0 ") || line.startsWith("127.0.0.1 ")) {
                    val host = line.substringAfter(' ').trim().substringBefore(' ').substringBefore('#').lowercase()
                    if (HOST.matches(host) && host != "localhost") block.add(host)
                    continue
                }
                val exception = line.startsWith("@@")
                val rule = if (exception) line.substring(2) else line
                if (!rule.startsWith("||")) continue
                val caret = rule.indexOf('^')
                if (caret < 0) continue
                val host = rule.substring(2, caret).lowercase()
                val rest = rule.substring(caret + 1)
                // Nothing after the ^ but options: a whole server.
                if (rest.isNotEmpty() && !rest.startsWith("$")) continue
                if (rest.startsWith("$")) {
                    val options = rest.substring(1).split(',').map { it.trim().lowercase() }
                    if (!options.all { it in SIMPLE_OPTIONS }) continue
                }
                if (!HOST.matches(host)) continue
                if (exception) allow.add(host) else block.add(host)
            }
        }

        // Whether a request to `host` from a page on `pageHost` is blocked by
        // `block` (and not let through by `allow`). A site's requests to
        // itself never are: only third parties.
        fun matches(host: String, pageHost: String, block: Set<String>, allow: Set<String>): Boolean {
            if (host.isEmpty() || UrlTools.sameSite(host, pageHost)) return false
            var h = host
            while (true) {
                if (h in allow) return false
                if (h in block) return true
                val dot = h.indexOf('.')
                if (dot < 0 || h.indexOf('.', dot + 1) < 0) return false
                h = h.substring(dot + 1)
            }
        }
    }

    @Volatile private var block: Set<String> = emptySet()
    @Volatile private var allow: Set<String> = emptySet()
    @Volatile var enabled = true
    @Volatile var offSites: Set<String> = emptySet()
    @Volatile var ruleCount = 0
        private set
    @Volatile var updatedAt = 0L
        private set

    private val worker = Executors.newSingleThreadExecutor()
    private val dir = File(context.filesDir, "shields").apply { mkdirs() }

    // Reads the lists (downloaded ones first, else the ones that came with
    // the app), then updates them in the background if they're old.
    fun load(onChange: () -> Unit) {
        worker.execute {
            reload()
            onChange()
            if (System.currentTimeMillis() - updatedAt > MAX_AGE_MS) {
                if (download() > 0) {
                    reload()
                    onChange()
                }
            }
        }
    }

    // Downloads every list again now; calls back with how many rules there are.
    fun update(done: (Int) -> Unit) {
        worker.execute {
            download()
            reload()
            done(ruleCount)
        }
    }

    private fun reload() {
        val b = HashSet<String>(120_000)
        val a = HashSet<String>(4_000)
        var newest = 0L
        for (list in LISTS) {
            val own = File(dir, "${list.id}.txt")
            val text = if (own.exists()) {
                newest = maxOf(newest, own.lastModified())
                own.readText()
            } else {
                runCatching { context.assets.open("shields/${list.id}.txt").bufferedReader().use { it.readText() } }.getOrNull()
            }
            if (text != null) parse(text, b, a)
        }
        block = b
        allow = a
        ruleCount = b.size
        updatedAt = newest
    }

    // How many lists came down.
    private fun download(): Int {
        var got = 0
        for (list in LISTS) {
            val text = Net.getText(list.url, timeoutMs = 30_000, maxBytes = 8 * 1024 * 1024) ?: continue
            if (text.length < 1000) continue
            File(dir, "${list.id}.txt.part").writeText(text)
            File(dir, "${list.id}.txt.part").renameTo(File(dir, "${list.id}.txt"))
            got++
        }
        return got
    }

    // Called for every request a page makes, on the engine's network thread.
    fun shouldBlock(host: String, pageHost: String): Boolean {
        if (!enabled || pageHost.isEmpty()) return false
        if (offSites.contains(pageHost.removePrefix("www."))) return false
        return matches(host, pageHost, block, allow)
    }
}

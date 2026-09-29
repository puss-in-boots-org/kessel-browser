package com.kessel.browser

import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

// What the address bar fetches on its own (like the desktop's suggest.rs):
// your search engine's suggestions, the ECB's currency rates and
// Wiktionary's definitions. Never from a private tab (the UI doesn't ask).
object Net {
    private const val KESSEL_AGENT = "Kessel/0.8 (https://github.com/puss-in-boots-org/kessel-browser)"
    val pool = Executors.newFixedThreadPool(4)

    fun getText(url: String, timeoutMs: Int = 4000, maxBytes: Int = 1024 * 1024, userAgent: String? = null): String? {
        val conn = try {
            URL(url).openConnection() as HttpURLConnection
        } catch (e: Exception) {
            return null
        }
        conn.connectTimeout = timeoutMs
        conn.readTimeout = timeoutMs
        conn.instanceFollowRedirects = true
        if (userAgent != null) conn.setRequestProperty("User-Agent", userAgent)
        try {
            if (conn.responseCode !in 200..299) return null
            conn.inputStream.use { input ->
                val out = ByteArrayOutputStream()
                val buf = ByteArray(16 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    if (out.size() > maxBytes) return null
                }
                return out.toString("UTF-8")
            }
        } catch (e: Exception) {
            return null
        } finally {
            conn.disconnect()
        }
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    // --- Search suggestions (OpenSearch: [query, [suggestions]]) ---

    fun suggestUrl(engine: String, query: String): String? {
        val q = enc(query)
        return when (engine) {
            "google" -> "https://suggestqueries.google.com/complete/search?client=firefox&q=$q"
            "bing" -> "https://api.bing.com/osjson.aspx?query=$q"
            "duckduckgo" -> "https://duckduckgo.com/ac/?type=list&q=$q"
            "brave" -> "https://search.brave.com/api/suggest?q=$q"
            "ecosia" -> "https://ac.ecosia.org/autocomplete?type=list&q=$q"
            "startpage" -> "https://www.startpage.com/suggestions?segment=startpage.udog&format=opensearch&q=$q"
            else -> null
        }
    }

    fun parseOpenSearch(body: String, query: String): List<String> = try {
        val list = JSONArray(body).getJSONArray(1)
        val seen = HashSet<String>()
        val out = ArrayList<String>()
        for (i in 0 until list.length()) {
            val item = list.get(i)
            val text = (if (item is JSONObject) item.optString("phrase") else item.toString()).trim()
            if (text.isEmpty() || text.equals(query.trim(), true) || !seen.add(text.lowercase())) continue
            out.add(text)
            if (out.size == 8) break
        }
        out
    } catch (e: Exception) {
        emptyList()
    }

    fun suggest(engine: String, query: String): List<String> {
        val q = query.trim()
        if (q.isEmpty() || q.length > 200) return emptyList()
        val url = suggestUrl(engine, q) ?: return emptyList()
        return getText(url, timeoutMs = 1500, maxBytes = 256 * 1024)?.let { parseOpenSearch(it, q) } ?: emptyList()
    }

    // --- Currency rates (the European Central Bank's, euro based) ---

    private const val ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"

    fun parseEcb(xml: String, now: Long = System.currentTimeMillis() / 1000): JSONObject? {
        val rates = JSONObject()
        var date = ""
        Regex("""time=['"]([^'"]+)['"]""").find(xml)?.let { date = it.groupValues[1] }
        for (m in Regex("""currency=['"]([A-Za-z]{3})['"]\s+rate=['"]([0-9.]+)['"]""").findAll(xml)) {
            rates.put(m.groupValues[1].uppercase(), m.groupValues[2].toDouble())
        }
        if (rates.length() == 0) return null
        rates.put("EUR", 1.0)
        return JSONObject().put("date", date).put("base", "EUR").put("rates", rates).put("fetched_at", now)
    }

    // Fetched at most every 6 hours; the last rates are kept for offline use.
    fun rates(dir: File): JSONObject? {
        val file = File(dir, "fx.json")
        val cached = runCatching { JSONObject(file.readText()) }.getOrNull()
        val age = System.currentTimeMillis() / 1000 - (cached?.optLong("fetched_at") ?: 0)
        if (cached != null && age < 6 * 3600) return cached
        val fresh = getText(ECB_URL, timeoutMs = 4000)?.let { parseEcb(it) }
        if (fresh != null) {
            runCatching { file.writeText(fresh.toString()) }
            return fresh
        }
        return cached
    }

    // --- Definitions (Wiktionary) ---

    fun htmlToText(html: String): String {
        var s = html.replace(Regex("(?is)<(style|script)[^>]*>.*?</\\1>"), " ")
        s = s.replace(Regex("<[^>]*>"), "")
        s = s.replace("&nbsp;", " ").replace("&quot;", "\"").replace("&#39;", "'").replace("&apos;", "'")
            .replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
        return s.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
    }

    fun parseDefinition(word: String, body: String): JSONObject? = try {
        val parts = JSONObject(body).getJSONArray("en")
        var found: JSONObject? = null
        loop@ for (i in 0 until parts.length()) {
            val part = parts.getJSONObject(i)
            val senses = part.optJSONArray("definitions") ?: continue
            for (j in 0 until senses.length()) {
                val sense = senses.getJSONObject(j)
                val definition = htmlToText(sense.optString("definition"))
                if (definition.isEmpty()) continue
                val example = sense.optJSONArray("examples")?.optString(0)?.let { htmlToText(it) } ?: ""
                found = JSONObject().put("word", word).put("phonetic", "").put("part", part.optString("partOfSpeech").lowercase())
                    .put("definition", definition).put("example", example)
                break@loop
            }
        }
        found
    } catch (e: Exception) {
        null
    }

    fun define(word: String): JSONObject? {
        val w = word.trim().lowercase()
        if (w.isEmpty() || w.length > 40 || !w.all { it.isLetter() || it == '-' || it == '\'' || it == ' ' }) return null
        val url = "https://en.wiktionary.org/api/rest_v1/page/definition/" + enc(w.replace(' ', '_')).replace("+", "%20")
        return getText(url, timeoutMs = 4000, maxBytes = 512 * 1024, userAgent = KESSEL_AGENT)?.let { parseDefinition(w, it) }
    }
}

package com.kessel.browser

// Addresses: the tracking parameters Shields removes from links, the
// desktop-site user agent, hosts. Plain Kotlin (no Android classes), so the
// unit tests run it on any JVM (app/src/test).
object UrlTools {
    // The same list as the desktop's Shields (../tauri-browser/src-tauri/src/shields.rs).
    // Matched case-insensitively; "utm_" is a prefix.
    private val TRACKING_PARAMS = setOf(
        "fbclid", "gclid", "gclsrc", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "twclid", "ttclid", "igshid",
        "igsh", "mc_eid", "_hsenc", "_hsmi", "__hssc", "__hstc", "__hsfp", "hsctatracking", "oly_anon_id",
        "oly_enc_id", "rb_clickid", "s_cid", "vero_conv", "vero_id", "wickedid", "_openstat", "ml_subscriber",
        "ml_subscriber_hash", "epik", "srsltid", "si", "ref_src", "mkt_tok", "trk_contact", "trk_msg", "trk_module",
        "trk_sid",
    )

    private fun isTracking(param: String): Boolean {
        val name = param.substringBefore('=').lowercase()
        return name.startsWith("utm_") || name in TRACKING_PARAMS
    }

    // `url` without its tracking parameters; the same string if it has none.
    fun stripTracking(url: String): String {
        if (!url.startsWith("http://", true) && !url.startsWith("https://", true)) return url
        val hashAt = url.indexOf('#')
        val fragment = if (hashAt >= 0) url.substring(hashAt) else ""
        val beforeFragment = if (hashAt >= 0) url.substring(0, hashAt) else url
        val queryAt = beforeFragment.indexOf('?')
        if (queryAt < 0) return url
        val params = beforeFragment.substring(queryAt + 1).split('&')
        val kept = params.filter { it.isNotEmpty() && !isTracking(it) }
        if (kept.size == params.count { it.isNotEmpty() }) return url
        val base = beforeFragment.substring(0, queryAt)
        return base + (if (kept.isEmpty()) "" else "?" + kept.joinToString("&")) + fragment
    }

    // The engine's phone user agent as a desktop Chrome's, for "Desktop
    // site": no Android, no "Mobile", no WebView markers.
    //   Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36
    // -> Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36
    fun desktopUserAgent(mobile: String): String =
        mobile
            .replace(Regex("""\(Linux; Android[^)]*\)"""), "(X11; Linux x86_64)")
            .replace(" Version/4.0", "")
            .replace(" Mobile Safari/", " Safari/")
            .replace(" Mobile", "")

    // The phone user agent without WebView's own markers ("; wv" and
    // "Version/4.0"), which some sites answer with an "open this in a real
    // browser" page.
    fun browserUserAgent(webView: String): String =
        webView.replace("; wv)", ")").replace(" Version/4.0", "")

    // "https://www.Example.com:8080/x" -> "www.example.com".
    fun hostOf(url: String): String {
        val afterScheme = url.substringAfter("://", "")
        if (afterScheme.isEmpty()) return ""
        val authority = afterScheme.substringBefore('/').substringBefore('?').substringBefore('#').substringAfterLast('@')
        val host = if (authority.startsWith("[")) authority.substringBefore(']') + "]" else authority.substringBefore(':')
        return host.lowercase()
    }

    // The part of a host a site owns, roughly: its last two labels
    // ("news.bbc.co.uk" -> "co.uk" is the price of not shipping the public
    // suffix list; Shields only uses it to leave a site's own requests alone).
    fun siteOf(host: String): String {
        val labels = host.trimEnd('.').split('.')
        return if (labels.size <= 2) host else labels.takeLast(2).joinToString(".")
    }

    fun sameSite(a: String, b: String): Boolean = a.isNotEmpty() && b.isNotEmpty() && siteOf(a) == siteOf(b)

    // A file name for a download from a data: URL: "download.png".
    fun dataUrlFileName(dataUrl: String, fallback: String = "download"): String {
        val mime = dataUrl.removePrefix("data:").substringBefore(';').substringBefore(',').lowercase()
        val ext = when (mime) {
            "image/png" -> "png"
            "image/jpeg" -> "jpg"
            "image/gif" -> "gif"
            "image/webp" -> "webp"
            "image/svg+xml" -> "svg"
            "application/pdf" -> "pdf"
            "text/plain" -> "txt"
            "text/csv" -> "csv"
            "text/html" -> "html"
            "application/json" -> "json"
            "application/zip" -> "zip"
            "audio/mpeg" -> "mp3"
            "video/mp4" -> "mp4"
            else -> "bin"
        }
        return "$fallback.$ext"
    }
}

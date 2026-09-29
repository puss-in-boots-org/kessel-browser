package com.kessel.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UrlToolsTest {
    @Test
    fun stripsTrackingParameters() {
        assertEquals("https://example.com/page?id=7", UrlTools.stripTracking("https://example.com/page?id=7&utm_source=x&fbclid=abc"))
        assertEquals("https://example.com/page", UrlTools.stripTracking("https://example.com/page?UTM_Medium=mail&gclid=1"))
        assertEquals("https://example.com/p?a=1#part", UrlTools.stripTracking("https://example.com/p?a=1&si=xyz#part"))
        // Nothing to remove: the very same string.
        val clean = "https://example.com/search?q=utm_source&page=2"
        assertEquals(clean, UrlTools.stripTracking(clean))
        assertEquals("mailto:a@b.c?utm_source=x", UrlTools.stripTracking("mailto:a@b.c?utm_source=x"))
    }

    @Test
    fun desktopUserAgent() {
        val phone = "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36"
        assertEquals(
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
            UrlTools.desktopUserAgent(phone),
        )
        assertEquals(
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
            UrlTools.browserUserAgent(phone),
        )
    }

    @Test
    fun hosts() {
        assertEquals("www.example.com", UrlTools.hostOf("https://www.Example.com:8080/x?y#z"))
        assertEquals("example.com", UrlTools.hostOf("http://user:pw@example.com/"))
        assertEquals("", UrlTools.hostOf("about:blank"))
        assertEquals("example.com", UrlTools.siteOf("cdn.static.example.com"))
        assertTrue(UrlTools.sameSite("cdn.example.com", "www.example.com"))
        assertFalse(UrlTools.sameSite("ads.tracker.net", "www.example.com"))
        assertFalse(UrlTools.sameSite("", "example.com"))
    }

    @Test
    fun dataUrlNames() {
        assertEquals("download.png", UrlTools.dataUrlFileName("data:image/png;base64,iVBOR"))
        assertEquals("download.txt", UrlTools.dataUrlFileName("data:text/plain,hello"))
        assertEquals("download.bin", UrlTools.dataUrlFileName("data:,x"))
    }
}

package com.kessel.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ShieldsTest {
    private val list = """
        [Adblock Plus 2.0]
        ! A comment
        ||ads.example^
        ||tracker.net^${'$'}third-party
        ||cdn.tracker.net^${'$'}script,image
        ||partial.example/path/ad.js
        ||sneaky.example^${'$'}domain=news.site
        @@||good.ads.example^
        example.com##.banner
        0.0.0.0 hosts-style.example
        127.0.0.1 localhost
        ||Not A Host^
    """.trimIndent()

    private fun parsed(): Pair<Set<String>, Set<String>> {
        val block = HashSet<String>()
        val allow = HashSet<String>()
        Shields.parse(list, block, allow)
        return block to allow
    }

    @Test
    fun readsServerRules() {
        val (block, allow) = parsed()
        assertEquals(setOf("ads.example", "tracker.net", "cdn.tracker.net", "hosts-style.example"), block)
        assertEquals(setOf("good.ads.example"), allow)
    }

    @Test
    fun blocksThirdPartiesAndTheirSubdomains() {
        val (block, allow) = parsed()
        assertTrue(Shields.matches("ads.example", "news.site", block, allow))
        assertTrue(Shields.matches("img.ads.example", "news.site", block, allow))
        assertTrue(Shields.matches("hosts-style.example", "news.site", block, allow))
        // An exception wins.
        assertFalse(Shields.matches("good.ads.example", "news.site", block, allow))
        assertFalse(Shields.matches("x.good.ads.example", "news.site", block, allow))
        // A site's own requests are never blocked.
        assertFalse(Shields.matches("ads.example", "www.ads.example", block, allow))
        // Not on any list.
        assertFalse(Shields.matches("cdn.news.site", "news.site", block, allow))
        // Walking up a host stops at its site: a stray "com" on a list blocks nothing.
        assertFalse(Shields.matches("ads.example.com", "news.site", setOf("com"), allow))
    }
}

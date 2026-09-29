package com.kessel.browser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NetTest {
    @Test
    fun readsSuggestionServices() {
        assertEquals(listOf("kessel browser", "kessel run"), Net.parseOpenSearch("""["kessel",["kessel","kessel browser","Kessel Browser","kessel run"]]""", "kessel"))
        assertEquals(listOf("a b"), Net.parseOpenSearch("""["a",[{"phrase":"a b"}]]""", "a"))
        assertEquals(emptyList<String>(), Net.parseOpenSearch("not json", "a"))
        assertEquals(
            "https://suggestqueries.google.com/complete/search?client=firefox&q=a%26b",
            Net.suggestUrl("google", "a&b"),
        )
        assertNull(Net.suggestUrl("nope", "x"))
    }

    @Test
    fun readsEcbRates() {
        val xml = """<gesmes:Envelope><Cube><Cube time='2026-09-24'><Cube currency='USD' rate='1.0835'/><Cube currency='HUF' rate='395.10'/></Cube></Cube></gesmes:Envelope>"""
        val rates = Net.parseEcb(xml, now = 42)!!
        assertEquals("2026-09-24", rates.getString("date"))
        assertEquals(1.0835, rates.getJSONObject("rates").getDouble("USD"), 1e-9)
        assertEquals(1.0, rates.getJSONObject("rates").getDouble("EUR"), 1e-9)
        assertEquals(42, rates.getLong("fetched_at"))
        assertNull(Net.parseEcb("<html>nope</html>"))
    }

    @Test
    fun readsDefinitions() {
        val body = """{"en":[{"partOfSpeech":"Noun","definitions":[{"definition":""},{"definition":"<style>.x{}</style>A <a href=\"/wiki/happy\">happy</a> accident &amp; more.","examples":["<i>By</i> serendipity"]}]}]}"""
        val d = Net.parseDefinition("serendipity", body)!!
        assertEquals("noun", d.getString("part"))
        assertEquals("A happy accident & more.", d.getString("definition"))
        assertEquals("By serendipity", d.getString("example"))
        assertNull(Net.parseDefinition("x", "{}"))
    }
}

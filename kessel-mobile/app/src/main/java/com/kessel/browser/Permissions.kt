package com.kessel.browser

import android.Manifest
import android.content.pm.PackageManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import org.json.JSONArray
import org.json.JSONObject

// A site asking for the camera, the microphone or your location: Kessel
// asks you (the UI's prompt), remembers the answer for the site if you want
// (never for private tabs), and only then asks Android for its own
// permission, if the app doesn't have it yet.
class Permissions(private val activity: MainActivity, private val store: Store) {
    private class Ask(val host: String, val kinds: List<String>, val private: Boolean, val request: PermissionRequest?, val done: (Boolean) -> Unit)

    private var nextId = 1
    private val asks = HashMap<Int, Ask>()

    fun onWebRequest(tab: Tab, request: PermissionRequest) {
        val host = request.origin.host ?: ""
        val grant = ArrayList<String>()
        val kinds = ArrayList<String>()
        for (resource in request.resources) {
            when (resource) {
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> { kinds.add("camera"); grant.add(resource) }
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> { kinds.add("microphone"); grant.add(resource) }
                // Protected (DRM) video, for streaming services: like Chrome, allowed.
                PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID -> grant.add(resource)
            }
        }
        if (grant.isEmpty()) return request.deny()
        if (kinds.isEmpty()) return request.grant(grant.toTypedArray())
        ask(host, kinds, tab.private, request) { allow -> if (allow) request.grant(grant.toTypedArray()) else request.deny() }
    }

    fun onGeolocation(tab: Tab, origin: String, callback: GeolocationPermissions.Callback) {
        val host = UrlTools.hostOf(origin)
        ask(host, listOf("location"), tab.private, null) { allow -> callback.invoke(origin, allow, false) }
    }

    fun cancel(request: PermissionRequest) {
        val id = asks.entries.find { it.value.request === request }?.key ?: return
        asks.remove(id)
        activity.emit("permission-cancel", JSONObject().put("id", id))
    }

    private fun ask(host: String, kinds: List<String>, private: Boolean, request: PermissionRequest?, done: (Boolean) -> Unit) {
        val remembered = if (private) kinds.map { null } else kinds.map { store.permission(host, it) }
        when {
            remembered.any { it == false } -> done(false)
            remembered.all { it == true } -> ensureAndroid(kinds, done)
            else -> {
                val id = nextId++
                asks[id] = Ask(host, kinds, private, request, done)
                activity.emit("permission", JSONObject().put("id", id).put("host", host).put("kinds", JSONArray(kinds)).put("private", private))
            }
        }
    }

    // The UI's answer.
    fun answer(id: Int, allow: Boolean, remember: Boolean) {
        val ask = asks.remove(id) ?: return
        if (remember && !ask.private) ask.kinds.forEach { store.setPermission(ask.host, it, allow) }
        if (allow) ensureAndroid(ask.kinds, ask.done) else ask.done(false)
    }

    private fun androidPermissions(kind: String) = when (kind) {
        "camera" -> listOf(Manifest.permission.CAMERA)
        "microphone" -> listOf(Manifest.permission.RECORD_AUDIO)
        "location" -> listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        else -> emptyList()
    }

    private fun ensureAndroid(kinds: List<String>, done: (Boolean) -> Unit) {
        val needed = kinds.flatMap { androidPermissions(it) }
        val missing = needed.filter { activity.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) return done(true)
        activity.requestAndroidPermissions(missing) {
            val granted = needed.filter { activity.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }.toSet()
            // Location: an approximate one is enough.
            val ok = kinds.all { kind ->
                val perms = androidPermissions(kind)
                if (kind == "location") perms.any { it in granted } else perms.all { it in granted }
            }
            done(ok)
        }
    }

    // Settings -> Site permissions: [{ host, camera?, microphone?, location? }].
    fun list(): JSONArray {
        val out = JSONArray()
        store.permissions.keys().forEach { host ->
            val entry = JSONObject(store.permissions.getJSONObject(host).toString()).put("host", host)
            out.put(entry)
        }
        return out
    }
}

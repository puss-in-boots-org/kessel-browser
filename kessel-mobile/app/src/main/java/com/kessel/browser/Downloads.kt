package com.kessel.browser

import android.app.DownloadManager
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import android.webkit.URLUtil
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject

// Downloads go to the phone's Downloads folder: web files through Android's
// download manager (progress in the notification shade, resumes after a
// dropped connection); files a page makes itself (data: and blob:
// addresses) are saved directly. Kessel's Downloads list shows both.
class Downloads(private val activity: MainActivity, private val store: Store) {
    // Part of every Android build that can run a browser.
    private val manager: DownloadManager = activity.getSystemService(DownloadManager::class.java)!!
    private val main = Handler(Looper.getMainLooper())

    fun start(tab: Tab?, url: String, userAgent: String?, disposition: String?, mime: String?, length: Long) {
        when {
            url.startsWith("data:", true) -> saveDataUrl(url, null)
            url.startsWith("blob:", true) -> saveBlob(tab, url, disposition, mime)
            url.startsWith("http://", true) || url.startsWith("https://", true) -> enqueue(tab, url, userAgent, disposition, mime)
            else -> toast("Kessel can't download this kind of address")
        }
    }

    // A link or picture from the long-press menu.
    fun startUrl(tab: Tab?, url: String) = start(tab, url, tab?.webView?.settings?.userAgentString, null, null, -1)

    private fun enqueue(tab: Tab?, url: String, userAgent: String?, disposition: String?, mime: String?) {
        val name = URLUtil.guessFileName(url, disposition, mime)
        try {
            val request = DownloadManager.Request(Uri.parse(url))
                .setTitle(name)
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            mime?.takeIf { it.isNotBlank() }?.let { request.setMimeType(it) }
            // The site's cookies (a signed-in download) and the tab's user agent.
            activity.browser.cookieManager(tab).getCookie(url)?.let { request.addRequestHeader("Cookie", it) }
            userAgent?.let { request.addRequestHeader("User-Agent", it) }
            tab?.url?.takeIf { it.startsWith("http") }?.let { request.addRequestHeader("Referer", it) }
            val id = manager.enqueue(request)
            store.addDownload(JSONObject().put("key", "dm:$id").put("dm", id).put("name", name).put("url", url).put("mime", mime ?: "").put("time", store.now()))
            toast("Downloading $name")
            activity.emit("downloads", null)
        } catch (e: Exception) {
            toast("Couldn't download $name")
        }
    }

    // A blob: address only means something inside its page: the page reads
    // it and hands it over as a data: URL, which is saved like any other.
    private fun saveBlob(tab: Tab?, url: String, disposition: String?, mime: String?) {
        val wv = tab?.webView ?: return toast("Couldn't download this file")
        val name = URLUtil.guessFileName(url, disposition, mime).takeUnless { it.endsWith(".bin") && mime.isNullOrBlank() }
        val key = "__kesselBlob"
        val quoted = JSONObject.quote(url)
        wv.evaluateJavascript(
            "(function(){window.$key=null;fetch($quoted).then(function(r){return r.blob()}).then(function(b){" +
                "if(b.size>52428800){window.$key='error:too big';return}" +
                "var f=new FileReader();f.onload=function(){window.$key=f.result};f.readAsDataURL(b)})" +
                ".catch(function(e){window.$key='error:'+e})})()",
            null,
        )
        toast("Saving…")
        poll(wv, key, 0, name)
    }

    private fun poll(wv: WebView, key: String, tries: Int, name: String?) {
        if (tries > 150) return toast("Couldn't download this file")
        main.postDelayed({
            wv.evaluateJavascript("(function(){var v=window.$key;if(v)window.$key=null;return v})()") { result ->
                if (result == null || result == "null") {
                    poll(wv, key, tries + 1, name)
                } else {
                    val value = runCatching { JSONArray("[$result]").getString(0) }.getOrNull() ?: ""
                    if (value.startsWith("data:")) saveDataUrl(value, name) else toast("Couldn't download this file")
                }
            }
        }, 200)
    }

    private fun saveDataUrl(dataUrl: String, name: String?) {
        val comma = dataUrl.indexOf(',')
        if (comma < 0) return toast("Couldn't download this file")
        val meta = dataUrl.substring(5, comma)
        val mime = meta.substringBefore(';').ifBlank { "application/octet-stream" }
        val payload = dataUrl.substring(comma + 1)
        val bytes = try {
            if (meta.contains(";base64")) Base64.decode(payload, Base64.DEFAULT) else Uri.decode(payload).toByteArray()
        } catch (e: IllegalArgumentException) {
            return toast("Couldn't download this file")
        }
        val fileName = name ?: UrlTools.dataUrlFileName(dataUrl)
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, fileName)
            put(MediaStore.Downloads.MIME_TYPE, mime)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val resolver = activity.contentResolver
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return toast("Couldn't save $fileName")
        try {
            resolver.openOutputStream(uri)?.use { it.write(bytes) }
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            store.addDownload(
                JSONObject().put("key", "file:${System.currentTimeMillis()}").put("dm", -1).put("name", fileName).put("url", "")
                    .put("mime", mime).put("time", store.now()).put("uri", uri.toString()).put("size", bytes.size),
            )
            toast("Saved $fileName to Downloads")
            activity.emit("downloads", null)
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            toast("Couldn't save $fileName")
        }
    }

    // For the Downloads list: each one with how it's going.
    fun list(): JSONArray {
        val entries = store.downloads
        val ids = (0 until entries.length()).map { entries.getJSONObject(it).optLong("dm", -1) }.filter { it >= 0 }
        val status = HashMap<Long, JSONObject>()
        if (ids.isNotEmpty()) {
            manager.query(DownloadManager.Query().setFilterById(*ids.toLongArray()))?.use { c ->
                val idCol = c.getColumnIndex(DownloadManager.COLUMN_ID)
                val statusCol = c.getColumnIndex(DownloadManager.COLUMN_STATUS)
                val doneCol = c.getColumnIndex(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)
                val totalCol = c.getColumnIndex(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)
                while (c.moveToNext()) {
                    val state = when (c.getInt(statusCol)) {
                        DownloadManager.STATUS_SUCCESSFUL -> "done"
                        DownloadManager.STATUS_FAILED -> "failed"
                        DownloadManager.STATUS_PAUSED -> "paused"
                        DownloadManager.STATUS_PENDING -> "waiting"
                        else -> "running"
                    }
                    status[c.getLong(idCol)] = JSONObject().put("state", state).put("received", c.getLong(doneCol)).put("size", c.getLong(totalCol))
                }
            }
        }
        val out = JSONArray()
        for (i in 0 until entries.length()) {
            val e = JSONObject(entries.getJSONObject(i).toString())
            val dm = e.optLong("dm", -1)
            if (dm >= 0) {
                // Gone from the download manager: removed elsewhere.
                val s = status[dm] ?: JSONObject().put("state", "gone")
                s.keys().forEach { e.put(it, s.get(it)) }
            } else {
                e.put("state", "done").put("received", e.optLong("size"))
            }
            out.put(e)
        }
        return out
    }

    fun open(key: String) {
        val entry = find(key) ?: return
        val uri = contentUri(entry) ?: return toast("That file isn't there any more")
        val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, entry.optString("mime").ifBlank { activity.contentResolver.getType(uri) })
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            activity.startActivity(intent)
        } catch (e: Exception) {
            toast("No app on this phone opens this kind of file")
        }
    }

    // Deletes the file and forgets it.
    fun remove(key: String) {
        val entry = find(key) ?: return
        val dm = entry.optLong("dm", -1)
        if (dm >= 0) manager.remove(dm) else entry.optString("uri").takeIf { it.isNotEmpty() }?.let { runCatching { activity.contentResolver.delete(Uri.parse(it), null, null) } }
        store.removeDownload(key)
    }

    // Forgets the list; the files stay in Downloads.
    fun clearList() = store.clearDownloads()

    private fun find(key: String): JSONObject? {
        val entries = store.downloads
        return (0 until entries.length()).map { entries.getJSONObject(it) }.find { it.optString("key") == key }
    }

    private fun contentUri(entry: JSONObject): Uri? {
        val dm = entry.optLong("dm", -1)
        return if (dm >= 0) manager.getUriForDownloadedFile(dm) else entry.optString("uri").takeIf { it.isNotEmpty() }?.let { Uri.parse(it) }
    }

    private fun toast(text: String) = activity.toast(text)
}

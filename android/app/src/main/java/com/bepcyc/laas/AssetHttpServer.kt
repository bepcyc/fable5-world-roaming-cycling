package com.bepcyc.laas

import android.content.res.AssetManager
import java.io.FileNotFoundException
import java.io.IOException
import java.io.OutputStream
import java.net.BindException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Minimal loopback static file server. Serves the bundled `assets/www/`
 * (the whole Vite dist) over http://127.0.0.1:47862.
 *
 * Why loopback: 127.0.0.1 is a "potentially trustworthy" origin in Chromium =>
 * secure context => WebGPU + Web Bluetooth are permitted with NO TLS and NO
 * flags. A stable port keeps the origin constant so IndexedDB / localStorage /
 * BLE grants survive relaunch; on collision we fall back to an ephemeral port.
 *
 * Binds 127.0.0.1 ONLY — never 0.0.0.0 — so nothing is exposed to the LAN.
 *
 * Behaviour mirrors electron/main.cjs: identical MIME table, SPA index.html
 * fallback for unknown routes, and a `..` traversal guard.
 */
class AssetHttpServer(private val assets: AssetManager) {

    companion object {
        const val HOST = "127.0.0.1"
        const val PREFERRED_PORT = 47862

        private val MIME: Map<String, String> = mapOf(
            "html" to "text/html; charset=utf-8",
            "js" to "text/javascript; charset=utf-8",
            "mjs" to "text/javascript; charset=utf-8",
            "css" to "text/css; charset=utf-8",
            "json" to "application/json; charset=utf-8",
            "webmanifest" to "application/manifest+json; charset=utf-8",
            "wasm" to "application/wasm",
            "png" to "image/png",
            "webp" to "image/webp",
            "jpg" to "image/jpeg",
            "jpeg" to "image/jpeg",
            "svg" to "image/svg+xml",
            "glb" to "model/gltf-binary",
            "bin" to "application/octet-stream",
            "ktx2" to "image/ktx2"
        )
    }

    private var serverSocket: ServerSocket? = null
    private val pool: ExecutorService = Executors.newCachedThreadPool()
    @Volatile private var running = false

    /** Bound port, valid only after start() returns. */
    var port: Int = 0
        private set

    /** Bind synchronously (so `port` is known before we launch the tab), then
     *  spawn a daemon accept loop. */
    fun start() {
        val socket = ServerSocket()
        socket.reuseAddress = true
        try {
            socket.bind(InetSocketAddress(InetAddress.getByName(HOST), PREFERRED_PORT))
        } catch (_: BindException) {
            // preferred port taken — ephemeral fallback (origin resets, grants lost)
            socket.bind(InetSocketAddress(InetAddress.getByName(HOST), 0))
        }
        serverSocket = socket
        port = socket.localPort
        running = true

        val acceptThread = Thread {
            while (running) {
                val client = try {
                    socket.accept()
                } catch (_: IOException) {
                    break // socket closed by stop()
                }
                pool.execute { handle(client) }
            }
        }
        acceptThread.isDaemon = true
        acceptThread.name = "laas-http-accept"
        acceptThread.start()
    }

    fun stop() {
        running = false
        try {
            serverSocket?.close()
        } catch (_: IOException) {
            // ignore
        }
        pool.shutdownNow()
    }

    private fun handle(client: Socket) {
        client.use { sock ->
            try {
                val input = sock.getInputStream()
                // read the request line only (we ignore headers/body)
                val requestLine = readLine(input) ?: return
                if (requestLine.isEmpty()) return
                // drain the rest of the header block so the client isn't RST'd
                while (true) {
                    val h = readLine(input) ?: break
                    if (h.isEmpty()) break
                }

                val parts = requestLine.split(' ')
                val rawTarget = if (parts.size >= 2) parts[1] else "/"
                val out = sock.getOutputStream()

                val assetPath = resolveAssetPath(rawTarget)
                if (assetPath == null) {
                    // path traversal attempt
                    writeResponse(out, 403, "text/plain; charset=utf-8", "forbidden".toByteArray())
                    return
                }

                val body: ByteArray = try {
                    assets.open(assetPath).use { it.readBytes() }
                } catch (_: FileNotFoundException) {
                    serveIndexFallback(out)
                    return
                } catch (_: IOException) {
                    serveIndexFallback(out)
                    return
                }

                val ext = assetPath.substringAfterLast('.', "").lowercase()
                val mime = MIME[ext] ?: "application/octet-stream"
                writeResponse(out, 200, mime, body)
            } catch (_: IOException) {
                // client vanished mid-write — nothing to do
            }
        }
    }

    /**
     * Map a request target to an asset path under www/, or null on traversal.
     * Splits on '/', drops ''/'.', REJECTS any '..' segment, appends index.html
     * for directory/root requests.
     */
    private fun resolveAssetPath(rawTarget: String): String? {
        val pathOnly = rawTarget.substringBefore('?').substringBefore('#')
        val decoded = try {
            URLDecoder.decode(pathOnly, "UTF-8")
        } catch (_: IllegalArgumentException) {
            pathOnly
        }
        val segments = ArrayList<String>()
        for (seg in decoded.split('/')) {
            when (seg) {
                "", "." -> {} // skip
                ".." -> return null // traversal guard
                else -> segments.add(seg)
            }
        }
        val trailingSlash = decoded.endsWith("/")
        var joined = segments.joinToString("/")
        if (joined.isEmpty() || trailingSlash) {
            joined = if (joined.isEmpty()) "index.html" else "$joined/index.html"
        }
        return "www/$joined"
    }

    private fun serveIndexFallback(out: OutputStream) {
        val idx = try {
            assets.open("www/index.html").use { it.readBytes() }
        } catch (_: IOException) {
            writeResponse(out, 404, "text/plain; charset=utf-8", "not found".toByteArray())
            return
        }
        writeResponse(out, 200, MIME["html"]!!, idx)
    }

    private fun writeResponse(out: OutputStream, status: Int, contentType: String, body: ByteArray) {
        val reason = when (status) {
            200 -> "OK"
            403 -> "Forbidden"
            404 -> "Not Found"
            else -> "OK"
        }
        val header = buildString {
            append("HTTP/1.1 ").append(status).append(' ').append(reason).append("\r\n")
            append("Content-Type: ").append(contentType).append("\r\n")
            append("Content-Length: ").append(body.size).append("\r\n")
            append("Cache-Control: no-cache\r\n")
            append("Connection: close\r\n")
            append("\r\n")
        }
        out.write(header.toByteArray(Charsets.US_ASCII))
        out.write(body)
        out.flush()
    }

    /** Read a single CRLF-terminated line (bytes), returning null at EOF. */
    private fun readLine(input: java.io.InputStream): String? {
        val sb = StringBuilder()
        var sawAny = false
        while (true) {
            val b = input.read()
            if (b == -1) return if (sawAny) sb.toString() else null
            sawAny = true
            if (b == '\n'.code) break
            if (b != '\r'.code) sb.append(b.toChar())
        }
        return sb.toString()
    }
}

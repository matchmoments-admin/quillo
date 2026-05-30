package au.askarthur.taxagent

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.UUID
import java.util.concurrent.TimeUnit
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Signs and POSTs receipt bytes to `{baseUrl}/ingest`.
 *
 * MUST match the Worker's verifyIngest (tax-agent/src/ingest/auth.ts):
 *   signature = HMAC-SHA256(secret, bytes("${ts}.${nonce}.") ++ rawBody), hex.
 * Identity is derived server-side from x-key-id — we do NOT send x-user-id.
 * The body's media type sets the Content-Type the Worker reads.
 */
object Uploader {
    private val client = OkHttpClient.Builder()
        .callTimeout(90, TimeUnit.SECONDS)
        .build()

    data class Result(val ok: Boolean, val code: Int, val body: String)

    fun uploadIngest(
        prov: Provisioning,
        bytes: ByteArray,
        mime: String,
        source: String = "android",
        bucketHint: String? = null,
    ): Result {
        val ts = System.currentTimeMillis().toString()
        val nonce = UUID.randomUUID().toString()
        val signed = "$ts.$nonce.".toByteArray(Charsets.UTF_8) + bytes
        val sig = hmacHex(prov.secret, signed)

        val builder = Request.Builder()
            .url("${prov.baseUrl}/ingest")
            .addHeader("x-key-id", prov.keyId)
            .addHeader("x-timestamp", ts)
            .addHeader("x-nonce", nonce)
            .addHeader("x-signature", sig)
            .addHeader("x-source", source)
            .post(bytes.toRequestBody(mime.toMediaType()))
        if (bucketHint != null) builder.addHeader("x-bucket", bucketHint)

        return runCatching {
            client.newCall(builder.build()).execute().use { resp ->
                Result(resp.isSuccessful, resp.code, resp.body?.string().orEmpty())
            }
        }.getOrElse { Result(false, -1, it.message ?: "network error") }
    }

    private fun hmacHex(secret: ByteArray, data: ByteArray): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret, "HmacSHA256"))
        return mac.doFinal(data).joinToString("") { "%02x".format(it) }
    }
}

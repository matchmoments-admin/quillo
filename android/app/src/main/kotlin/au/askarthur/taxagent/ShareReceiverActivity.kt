package au.askarthur.taxagent

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Capability 1 — the reliable backbone. Registered as a SEND share target for
 * image/* and application/pdf. Reads the shared bytes, signs, uploads, finishes.
 */
class ShareReceiverActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val uri = extractStreamUri(intent)
        if (uri == null) {
            toast("No file was shared")
            finish()
            return
        }
        if (!SecretStore.isProvisioned(this)) {
            toast("Open Tax Agent and connect your key first")
            finish()
            return
        }

        val mime = intent.type ?: contentResolver.getType(uri) ?: "image/jpeg"
        lifecycleScope.launch {
            val res = withContext(Dispatchers.IO) {
                val bytes = contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                Uploader.uploadIngest(SecretStore.load(this@ShareReceiverActivity)!!, bytes, mime, "android")
            }
            toast(if (res.ok) "Receipt sent to Tax Agent" else "Upload failed (${res.code})")
            finish()
        }
    }

    @Suppress("DEPRECATION")
    private fun extractStreamUri(intent: Intent): Uri? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            intent.getParcelableExtra(Intent.EXTRA_STREAM)
        }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
}

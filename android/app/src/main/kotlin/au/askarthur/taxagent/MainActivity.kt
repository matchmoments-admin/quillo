package au.askarthur.taxagent

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import au.askarthur.taxagent.ui.theme.TaxAgentTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { TaxAgentTheme { Surface(Modifier.fillMaxSize()) { AppRoot() } } }
    }
}

private enum class Screen { HOME, DIAGNOSTICS }

@Composable
private fun AppRoot() {
    val ctx = LocalContext.current
    var provisioned by remember { mutableStateOf(SecretStore.isProvisioned(ctx)) }
    var screen by remember { mutableStateOf(Screen.HOME) }

    if (!provisioned) {
        ProvisionScreen(onSaved = { provisioned = true })
        return
    }
    when (screen) {
        Screen.HOME -> HomeScreen(
            onDiagnostics = { screen = Screen.DIAGNOSTICS },
            onReset = { SecretStore.clear(ctx); provisioned = false },
        )
        Screen.DIAGNOSTICS -> DiagnosticsScreen(onBack = { screen = Screen.HOME })
    }
}

@Composable
private fun ProvisionScreen(onSaved: () -> Unit) {
    val ctx = LocalContext.current
    var baseUrl by remember { mutableStateOf("https://tax-agent.<you>.workers.dev") }
    var keyId by remember { mutableStateOf("") }
    var secret by remember { mutableStateOf("") }

    Column(
        Modifier.fillMaxSize().padding(24.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Connect to your Tax Agent", style = MaterialTheme.typography.headlineSmall)
        Text(
            "Run  node scripts/seed-tenant.mjs me me android  in the tax-agent repo and paste the values below.",
            style = MaterialTheme.typography.bodySmall,
        )
        OutlinedTextField(baseUrl, { baseUrl = it }, label = { Text("Worker base URL") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedTextField(keyId, { keyId = it }, label = { Text("KEY_ID") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedTextField(secret, { secret = it }, label = { Text("SECRET") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        Button(
            onClick = { SecretStore.save(ctx, keyId, secret, baseUrl); onSaved() },
            enabled = keyId.isNotBlank() && secret.isNotBlank() && baseUrl.startsWith("http"),
        ) { Text("Save & connect") }
    }
}

@Composable
private fun HomeScreen(onDiagnostics: () -> Unit, onReset: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var bucket by remember { mutableStateOf("company") }
    var status by remember { mutableStateOf("") }
    var pendingUri by remember { mutableStateOf<Uri?>(null) }

    val takePicture = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val uri = pendingUri
        if (ok && uri != null) {
            scope.launch {
                status = "Uploading…"
                val res = withContext(Dispatchers.IO) {
                    val bytes = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                    Uploader.uploadIngest(SecretStore.load(ctx)!!, bytes, "image/jpeg", "android", bucket)
                }
                status = if (res.ok) "✓ Sent ($bucket)" else "✗ ${res.code}: ${res.body.take(140)}"
            }
        } else {
            status = "Capture cancelled"
        }
    }

    Column(
        Modifier.fillMaxSize().padding(24.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Tax Agent", style = MaterialTheme.typography.headlineMedium)
        Text("Bucket for the next receipt:", style = MaterialTheme.typography.labelLarge)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("payg" to "PAYG", "company" to "Company", "property_rented" to "Property").forEach { (v, label) ->
                if (bucket == v) {
                    Button(onClick = { bucket = v }) { Text(label) }
                } else {
                    OutlinedButton(onClick = { bucket = v }) { Text(label) }
                }
            }
        }
        Button(
            onClick = {
                val uri = newCaptureUri(ctx)
                pendingUri = uri
                takePicture.launch(uri)
            },
            modifier = Modifier.fillMaxWidth().height(64.dp),
        ) { Text("Snap receipt") }

        Text("Or share any receipt image/PDF to \"Tax Agent\" from another app.", style = MaterialTheme.typography.bodySmall)
        if (status.isNotBlank()) Text(status, fontFamily = FontFamily.Monospace)

        Spacer(Modifier.height(8.dp))
        TextButton(onClick = onDiagnostics) { Text("Wallet capture diagnostics →") }
        TextButton(onClick = onReset) { Text("Re-provision / clear key") }
    }
}

@Composable
private fun DiagnosticsScreen(onBack: () -> Unit) {
    val ctx = LocalContext.current
    var lines by remember { mutableStateOf(Diagnostics.read(ctx)) }

    Column(
        Modifier.fillMaxSize().padding(24.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Wallet capture self-test", style = MaterialTheme.typography.headlineSmall)
        Text(
            "Tap-to-pay logging is best-effort. Android 15+ often blocks notification access " +
                "for sideloaded apps and/or hides payment details. Below is exactly what your " +
                "device exposed when you tapped to pay.",
            style = MaterialTheme.typography.bodySmall,
        )
        Button(onClick = { ctx.startActivity(Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS")) }) {
            Text("Open notification access settings")
        }
        Text(
            "If Settings won't let you enable it (restricted), grant via ADB:\n" +
                "adb shell cmd notification allow_listener \\\n" +
                "  au.askarthur.taxagent/au.askarthur.taxagent.TxnListener",
            style = MaterialTheme.typography.bodySmall,
            fontFamily = FontFamily.Monospace,
        )
        if (lines.isEmpty()) {
            Text("No Wallet notifications observed yet. Make a tap-to-pay, then Refresh.")
        } else {
            lines.forEach { Text(it, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { lines = Diagnostics.read(ctx) }) { Text("Refresh") }
            OutlinedButton(onClick = { Diagnostics.clear(ctx); lines = emptyList() }) { Text("Clear") }
        }
        TextButton(onClick = onBack) { Text("← Back") }
    }
}

private fun newCaptureUri(ctx: Context): Uri {
    val dir = File(ctx.cacheDir, "captures").apply { mkdirs() }
    val file = File(dir, "receipt_${System.currentTimeMillis()}.jpg")
    return FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
}

package au.askarthur.taxagent

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * OPTIONAL, best-effort Capability 3: observe Google Wallet tap-to-pay notifications.
 *
 * Reality check (2026): on Android 15+ this is frequently blocked for sideloaded apps
 * and/or the payment content is replaced with a "sensitive content hidden" placeholder.
 * So this runs in SELF-TEST mode only — it records what the device actually exposed to
 * the Diagnostics screen. It deliberately does NOT auto-upload: tap-to-pay is a nudge,
 * never a source of truth. Promote to an actionable "Log $X at Y?" prompt only after
 * the self-test confirms usable data on this specific device.
 */
class TxnListener : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName != WALLET_PKG) return
        val extras = sbn.notification.extras
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()

        val blocked = title.isNullOrBlank() && text.isNullOrBlank()
        val looksRedacted = listOfNotNull(title, text).any {
            it.contains("sensitive", ignoreCase = true) && it.contains("hidden", ignoreCase = true)
        }
        val flag = when {
            blocked -> " | BLOCKED (no content delivered)"
            looksRedacted -> " | REDACTED by OS"
            else -> ""
        }
        val stamp = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
        Diagnostics.record(
            applicationContext,
            "[$stamp] wallet — title=${title ?: "∅"} | text=${text ?: "∅"}$flag",
        )
    }

    companion object {
        const val WALLET_PKG = "com.google.android.apps.walletnfcrel"
    }
}

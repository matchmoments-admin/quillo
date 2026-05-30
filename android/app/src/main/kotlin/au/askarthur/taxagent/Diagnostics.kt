package au.askarthur.taxagent

import android.content.Context

/** Tiny ring buffer (SharedPreferences-backed) for the Wallet listener self-test. */
object Diagnostics {
    private const val PREFS = "taxagent.diag"
    private const val K_LOG = "log"
    private const val MAX = 25

    fun record(ctx: Context, line: String) {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val kept = (listOf(line) + read(ctx)).filter { it.isNotBlank() }.take(MAX)
        p.edit().putString(K_LOG, kept.joinToString("\n")).apply()
    }

    fun read(ctx: Context): List<String> =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(K_LOG, "").orEmpty()
            .split("\n").filter { it.isNotBlank() }

    fun clear(ctx: Context) =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
}

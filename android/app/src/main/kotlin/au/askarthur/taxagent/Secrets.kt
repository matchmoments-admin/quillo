package au.askarthur.taxagent

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Provisioned tenant credentials (matches `scripts/seed-tenant.mjs` output). */
data class Provisioning(val keyId: String, val secret: ByteArray, val baseUrl: String)

/**
 * Stores the per-tenant ingest credentials.
 *
 * The HMAC secret is SHARED with the server (the Worker stores the same secret to
 * verify signatures), so it cannot be a non-exportable Keystore signing key. We use
 * the standard envelope pattern: a hardware-backed Keystore AES-GCM key encrypts the
 * secret at rest, and only the ciphertext lives in SharedPreferences (plaintext store
 * is fine — the contents are encrypted). This deliberately avoids the deprecated
 * EncryptedSharedPreferences / androidx.security-crypto library.
 */
object SecretStore {
    private const val PREFS = "taxagent.secrets"
    private const val KS_ALIAS = "taxagent.secretwrap"
    private const val ANDROID_KS = "AndroidKeyStore"
    private const val K_KEY_ID = "key_id"
    private const val K_BASE_URL = "base_url"
    private const val K_SECRET_CT = "secret_ct"
    private const val K_SECRET_IV = "secret_iv"
    private const val GCM_TAG_BITS = 128

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun isProvisioned(ctx: Context): Boolean = prefs(ctx).contains(K_SECRET_CT)

    fun save(ctx: Context, keyId: String, secret: String, baseUrl: String) {
        val (iv, ct) = encrypt(secret.toByteArray(Charsets.UTF_8))
        prefs(ctx).edit()
            .putString(K_KEY_ID, keyId.trim())
            .putString(K_BASE_URL, baseUrl.trim().trimEnd('/'))
            .putString(K_SECRET_IV, Base64.encodeToString(iv, Base64.NO_WRAP))
            .putString(K_SECRET_CT, Base64.encodeToString(ct, Base64.NO_WRAP))
            .apply()
    }

    fun load(ctx: Context): Provisioning? {
        val p = prefs(ctx)
        val keyId = p.getString(K_KEY_ID, null) ?: return null
        val baseUrl = p.getString(K_BASE_URL, null) ?: return null
        val iv = p.getString(K_SECRET_IV, null)?.let { Base64.decode(it, Base64.NO_WRAP) } ?: return null
        val ct = p.getString(K_SECRET_CT, null)?.let { Base64.decode(it, Base64.NO_WRAP) } ?: return null
        return Provisioning(keyId, decrypt(iv, ct), baseUrl)
    }

    fun clear(ctx: Context) = prefs(ctx).edit().clear().apply()

    private fun wrapKey(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KS).apply { load(null) }
        (ks.getEntry(KS_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KS)
        kg.init(
            KeyGenParameterSpec.Builder(
                KS_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return kg.generateKey()
    }

    private fun encrypt(plain: ByteArray): Pair<ByteArray, ByteArray> {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, wrapKey())
        return cipher.iv to cipher.doFinal(plain)
    }

    private fun decrypt(iv: ByteArray, ct: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, wrapKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
        return cipher.doFinal(ct)
    }
}

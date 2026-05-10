package com.r503.power

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class R503PowerModule : Module() {
  companion object {
    // Static field so the lock outlives module-instance recycling.
    // Expo destroys and recreates module instances on every JS-bridge reset
    // (e.g. after an uncaught exception or RN dev-reload). An instance-scoped
    // lock is GC'd at that point and the OS silently releases PARTIAL_WAKE_LOCK,
    // letting the CPU sleep between GPS callbacks even when the foreground
    // service notification is still visible.
    @Volatile private var staticWakeLock: PowerManager.WakeLock? = null
  }

  private val context: Context
    get() = requireNotNull(appContext.reactContext) {
      "R503Power: react context is unavailable"
    }.applicationContext

  override fun definition() = ModuleDefinition {
    Name("R503Power")

    AsyncFunction("acquireWakeLock") { tag: String ->
      val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      val lock = staticWakeLock ?: pm.newWakeLock(
        PowerManager.PARTIAL_WAKE_LOCK,
        "r503:$tag"
      ).apply {
        setReferenceCounted(false)
      }.also { staticWakeLock = it }

      if (!lock.isHeld) {
        // Hard cap of 6 hours as a safety net. Any single trip is far shorter,
        // and the JS layer always releases on stopTrip() — this only protects
        // against a JS-side crash leaving the lock held indefinitely.
        lock.acquire(6 * 60 * 60 * 1000L)
      }
      true
    }

    AsyncFunction("releaseWakeLock") {
      staticWakeLock?.let { lock ->
        if (lock.isHeld) {
          lock.release()
        }
      }
      true
    }

    AsyncFunction("isWakeLockHeld") {
      staticWakeLock?.isHeld == true
    }

    AsyncFunction("isIgnoringBatteryOptimizations") {
      val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    AsyncFunction("requestIgnoreBatteryOptimizations") {
      val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      if (pm.isIgnoringBatteryOptimizations(context.packageName)) {
        return@AsyncFunction true
      }
      val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
        data = Uri.parse("package:${context.packageName}")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      try {
        context.startActivity(intent)
        true
      } catch (_: Exception) {
        false
      }
    }
  }
}

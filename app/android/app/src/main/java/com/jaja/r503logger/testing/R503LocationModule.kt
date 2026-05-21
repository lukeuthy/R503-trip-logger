package com.jaja.r503logger.testing

import android.content.Intent
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap

class R503LocationModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "R503LocationModule"

    override fun initialize() {
        super.initialize()
        ReactBridge.setContext(reactContext)
    }

    @ReactMethod
    fun startTracking(options: ReadableMap, promise: Promise) {
        try {
            val intervalMs = options.getDouble("intervalMs").toLong()
            val title = if (options.hasKey("title")) options.getString("title") ?: "R503 Logger" else "R503 Logger"
            val text = if (options.hasKey("text")) options.getString("text") ?: "GPS active" else "GPS active"
            val useForegroundService = if (options.hasKey("useForegroundService")) options.getBoolean("useForegroundService") else true

            val intent = Intent(reactContext, R503LocationService::class.java).apply {
                putExtra(R503LocationService.EXTRA_INTERVAL_MS, intervalMs)
                putExtra(R503LocationService.EXTRA_TITLE, title)
                putExtra(R503LocationService.EXTRA_TEXT, text)
                putExtra(R503LocationService.EXTRA_USE_FOREGROUND_SERVICE, useForegroundService)
            }
            ContextCompat.startForegroundService(reactContext, intent)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("START_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun stopTracking(promise: Promise) {
        try {
            reactContext.stopService(Intent(reactContext, R503LocationService::class.java))
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("STOP_FAILED", e.message, e)
        }
    }

    @ReactMethod
    fun isTracking(promise: Promise) {
        // Simple check: attempt getLastLocation — if service is running FusedClient will respond
        // In practice, the JS side tracks state directly via the service-restart event
        promise.resolve(false)
    }

    // Required for new architecture event listener registration
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}
}

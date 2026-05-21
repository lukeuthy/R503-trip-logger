package com.jaja.r503logger.testing

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

/**
 * Native foreground service for R503 GPS tracking.
 *
 * Uses START_STICKY so Android automatically restarts it after OEM battery
 * managers (Motorola MyUX) kill it — without requiring the app to call
 * startForegroundService() from a background context, which is banned on
 * Android 12+ (ForegroundServiceStartNotAllowedException).
 *
 * Delivers location fixes to JS via DeviceEventEmitter("r503-location").
 */
class R503LocationService : Service() {

    companion object {
        const val CHANNEL_ID = "r503_gps_channel"
        const val NOTIFICATION_ID = 2001
        const val EXTRA_INTERVAL_MS = "intervalMs"
        const val EXTRA_TITLE = "notifTitle"
        const val EXTRA_TEXT = "notifText"
        const val EXTRA_USE_FOREGROUND_SERVICE = "useForegroundService"
        const val EVENT_LOCATION = "r503-location"
        const val EVENT_SERVICE_RESTART = "r503-service-restart"
    }

    private lateinit var fusedClient: FusedLocationProviderClient
    private var intervalMs: Long = 5000L
    private var useForegroundService: Boolean = true

    private val locationCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            val loc = result.lastLocation ?: return
            val params = Arguments.createMap().apply {
                putDouble("timestampMs", loc.time.toDouble())
                putDouble("latitude", loc.latitude)
                putDouble("longitude", loc.longitude)
                putDouble("accuracy", loc.accuracy.toDouble())
                putDouble("speed", if (loc.hasSpeed()) loc.speed.toDouble() else -1.0)
                putDouble("heading", if (loc.hasBearing()) loc.bearing.toDouble() else -1.0)
                putDouble("altitude", if (loc.hasAltitude()) loc.altitude else 0.0)
            }
            ReactBridge.emitEvent(EVENT_LOCATION, params)
        }
    }

    override fun onCreate() {
        super.onCreate()
        fusedClient = LocationServices.getFusedLocationProviderClient(this)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        intervalMs = intent?.getLongExtra(EXTRA_INTERVAL_MS, 5000L) ?: 5000L
        useForegroundService = intent?.getBooleanExtra(EXTRA_USE_FOREGROUND_SERVICE, true) ?: true
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: "R503 Logger"
        val text = intent?.getStringExtra(EXTRA_TEXT) ?: "GPS recording active"

        if (useForegroundService) {
            startForeground(NOTIFICATION_ID, buildNotification(title, text))
        }

        // Emit restart event so JS can increment task_restart_count
        ReactBridge.emitEvent(EVENT_SERVICE_RESTART, Arguments.createMap())

        startLocationUpdates()

        // START_STICKY: OS will restart the service with a null intent when killed.
        // This is the key difference from expo-location's approach — the service
        // restarts itself natively without needing JS to call startForegroundService().
        return START_STICKY
    }

    private fun startLocationUpdates() {
        val request = LocationRequest.Builder(intervalMs)
            .setPriority(Priority.PRIORITY_HIGH_ACCURACY)
            .setMinUpdateIntervalMillis(intervalMs)
            .setWaitForAccurateLocation(false)
            .build()

        try {
            fusedClient.requestLocationUpdates(request, locationCallback, Looper.getMainLooper())
        } catch (e: SecurityException) {
            // Permission not granted — JS side should have checked before starting
        }
    }

    override fun onDestroy() {
        fusedClient.removeLocationUpdates(locationCallback)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "R503 GPS Tracking",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Live GPS updates for R503 bus trip logging"
            setShowBadge(false)
        }
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(title: String, text: String): Notification {
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }
}

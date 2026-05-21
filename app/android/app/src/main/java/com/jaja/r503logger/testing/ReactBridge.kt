package com.jaja.r503logger.testing

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Singleton that holds a reference to the ReactApplicationContext so native
 * services (which aren't ReactContextBaseJavaModules) can emit JS events.
 */
object ReactBridge {
    private var context: ReactApplicationContext? = null

    fun setContext(ctx: ReactApplicationContext) {
        context = ctx
    }

    fun emitEvent(eventName: String, params: WritableMap) {
        context?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            ?.emit(eventName, params)
    }
}

import ExpoModulesCore

public class R503PowerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("R503Power")

    AsyncFunction("acquireWakeLock") { (_: String) -> Bool in
      true
    }

    AsyncFunction("releaseWakeLock") { () -> Bool in
      true
    }

    AsyncFunction("isWakeLockHeld") { () -> Bool in
      false
    }

    AsyncFunction("isIgnoringBatteryOptimizations") { () -> Bool in
      true
    }

    AsyncFunction("requestIgnoreBatteryOptimizations") { () -> Bool in
      false
    }
  }
}

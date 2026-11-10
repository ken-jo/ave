import Foundation
import AppKit
import CoreGraphics
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers

@MainActor
final class CaptureActivation: NSObject {
    let targetPid: Int32
    private(set) var targetActivated = false

    init(targetPid: Int32) {
        self.targetPid = targetPid
    }

    @objc func didActivate(_ notification: Notification) {
        guard let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
        if application.processIdentifier == targetPid { targetActivated = true }
    }
}

@main
enum NativeWindowCapture {
    @MainActor
    static func main() async {
        let granted = CGPreflightScreenCaptureAccess()
        if CommandLine.arguments.contains("--preflight") {
            print("{\"screenCaptureAccess\":\(granted)}")
            return
        }
        guard granted else {
            print("{\"error\":\"screen-capture-permission-unavailable\"}")
            exit(2)
        }
        NSApplication.shared.setActivationPolicy(.prohibited)
        guard CommandLine.arguments.count == 6,
              let windowId = UInt32(CommandLine.arguments[1]),
              let ownerPid = Int32(CommandLine.arguments[2]),
              let width = Int(CommandLine.arguments[3]),
              let height = Int(CommandLine.arguments[4]),
              width > 0, height > 0 else {
            print("{\"error\":\"invalid-native-capture-target\"}")
            exit(3)
        }
        do {
            let activation = CaptureActivation(targetPid: ownerPid)
            NSWorkspace.shared.notificationCenter.addObserver(activation,
                selector: #selector(CaptureActivation.didActivate(_:)),
                name: NSWorkspace.didActivateApplicationNotification, object: nil)
            defer { NSWorkspace.shared.notificationCenter.removeObserver(activation) }
            let frontmostBefore = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let window = content.windows.first(where: {
                $0.windowID == windowId && $0.owningApplication?.processID == ownerPid
            }) else {
                print("{\"error\":\"native-capture-window-unavailable\"}")
                exit(4)
            }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let configuration = SCStreamConfiguration()
            configuration.width = width
            configuration.height = height
            configuration.showsCursor = false
            configuration.ignoreShadowsSingleWindow = true
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            let output = URL(fileURLWithPath: CommandLine.arguments[5])
            guard let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil) else {
                throw NSError(domain: "NativeWindowCapture", code: 1)
            }
            CGImageDestinationAddImage(destination, image, nil)
            guard CGImageDestinationFinalize(destination) else {
                throw NSError(domain: "NativeWindowCapture", code: 2)
            }
            let result: [String: Any] = [
                "windowId": windowId, "ownerPid": ownerPid,
                "width": image.width, "height": image.height,
                "frontmostBefore": frontmostBefore,
                "frontmostAfter": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1,
                "targetActivatedDuringCapture": activation.targetActivated,
                "onScreen": window.isOnScreen,
            ]
            let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
            print(String(decoding: data, as: UTF8.self))
        } catch {
            print("Native window capture failed: \(error)")
            exit(5)
        }
    }
}

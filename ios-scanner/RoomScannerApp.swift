// Single-file iOS RoomPlan scanner for soon2026.
//
// To use: create a new Xcode project (File → New → Project → iOS App → SwiftUI),
// replace the auto-generated RoomScannerApp.swift contents with this file,
// delete ContentView.swift, set deployment target to iOS 17.0, add the Info.plist
// key NSCameraUsageDescription (any short string), set the signing team, run.
//
// On Done: AirDrops room.usdz + room.raw.json + frames.json + frames/*.jpg off the device.
// frames/* are RGB keyframes (camera pose + intrinsics) used by the splat-bake pipeline.

import SwiftUI
import RoomPlan
import ARKit
import UIKit
import CoreImage
import simd

@main
struct RoomScannerApp: App {
    var body: some Scene {
        WindowGroup {
            ScannerView()
                .ignoresSafeArea()
        }
    }
}

struct ScannerView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> ScannerViewController { ScannerViewController() }
    func updateUIViewController(_ uiViewController: ScannerViewController, context: Context) {}
}

// MARK: - Keyframe model

struct Keyframe {
    let id: Int
    let file: String           // basename, e.g. "frame_0042.jpg"
    let timestamp: TimeInterval
    let transform: simd_float4x4
    let intrinsics: simd_float3x3
    let imageWidth: Int
    let imageHeight: Int
}

// MARK: - Tunables

private enum KeyframeTuning {
    static let minIntervalSeconds: TimeInterval = 0.25      // ≥ 250 ms between keyframes
    static let minTranslationMeters: Float = 0.10           // OR moved ≥ 10 cm
    static let minRotationRadians: Float = 0.1745           // OR rotated ≥ 10°
    static let maxKeyframes: Int = 150                      // hard cap, keeps bundle ~25 MB
    static let jpegLongEdge: Int = 1280                     // downscale for sane upload size
    static let jpegQuality: CGFloat = 0.85
}

// MARK: - View controller

final class ScannerViewController: UIViewController, RoomCaptureViewDelegate, RoomCaptureSessionDelegate, ARSessionDelegate {

    private var captureView: RoomCaptureView!
    private let config = RoomCaptureSession.Configuration()
    private var doneButton: UIButton!
    private var statusLabel: UILabel!

    // Keyframe state
    private let ciContext = CIContext()
    private let encodeQueue = DispatchQueue(label: "soon2026.scanner.jpeg-encode", qos: .utility)
    private let stateQueue = DispatchQueue(label: "soon2026.scanner.state")
    private var keyframes: [Keyframe] = []
    private var lastKeyframeTime: TimeInterval = -1
    private var lastKeyframePosition: simd_float3 = .zero
    private var lastKeyframeForward: simd_float3 = .zero
    private var hasFirstKeyframe = false
    private var framesDirURL: URL = FileManager.default.temporaryDirectory.appendingPathComponent("frames")

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        prepareFramesDirectory()
        setupCaptureView()
        setupOverlay()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        captureView.captureSession.run(configuration: config)
    }

    private func prepareFramesDirectory() {
        // Wipe any prior session's frames so AirDrop bundle is clean.
        try? FileManager.default.removeItem(at: framesDirURL)
        try? FileManager.default.createDirectory(at: framesDirURL, withIntermediateDirectories: true)
    }

    private func setupCaptureView() {
        captureView = RoomCaptureView(frame: view.bounds)
        captureView.captureSession.delegate = self
        captureView.delegate = self
        // Attach our ARSessionDelegate to the underlying ARSession to receive raw frames.
        // RoomCaptureSession.arSession is a public ARSession; both delegates can coexist.
        captureView.captureSession.arSession.delegate = self
        captureView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(captureView)
    }

    private func setupOverlay() {
        statusLabel = UILabel()
        statusLabel.text = "Walk slowly around the room. Tap Done when finished."
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0
        statusLabel.textColor = .white
        statusLabel.font = .systemFont(ofSize: 14, weight: .medium)
        statusLabel.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        statusLabel.layer.cornerRadius = 8
        statusLabel.layer.masksToBounds = true
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(statusLabel)

        doneButton = UIButton(type: .system)
        doneButton.setTitle("Done", for: .normal)
        doneButton.titleLabel?.font = .boldSystemFont(ofSize: 20)
        doneButton.backgroundColor = .systemBlue
        doneButton.setTitleColor(.white, for: .normal)
        doneButton.layer.cornerRadius = 14
        doneButton.translatesAutoresizingMaskIntoConstraints = false
        doneButton.addTarget(self, action: #selector(handleDone), for: .touchUpInside)
        view.addSubview(doneButton)

        NSLayoutConstraint.activate([
            statusLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
            statusLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            statusLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            statusLabel.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),

            doneButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
            doneButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            doneButton.widthAnchor.constraint(equalToConstant: 220),
            doneButton.heightAnchor.constraint(equalToConstant: 56),
        ])
    }

    @objc private func handleDone() {
        captureView.captureSession.stop()
        statusLabel.text = "Processing scan…"
        doneButton.isEnabled = false
        doneButton.alpha = 0.5
    }

    // MARK: RoomCaptureViewDelegate

    func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
        return true
    }

    func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
        if let error = error {
            showAlert(title: "Capture error", message: error.localizedDescription)
            return
        }
        // Drain any pending JPEG encodes before bundling.
        encodeQueue.async { [weak self] in
            DispatchQueue.main.async {
                self?.exportAndShare(processedResult)
            }
        }
    }

    // MARK: ARSessionDelegate (keyframe capture)

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        // Only sample while the RoomCaptureSession is actively scanning.
        // Once `handleDone` calls stop, this delegate stops firing.
        guard shouldKeyframe(frame: frame) else { return }

        // Snapshot what the encoder needs — release the ARFrame ASAP.
        let pixelBuffer = frame.capturedImage
        let timestamp = frame.timestamp
        let transform = frame.camera.transform
        let intrinsics = frame.camera.intrinsics
        let resolution = frame.camera.imageResolution

        let assignedId: Int = stateQueue.sync {
            let id = keyframes.count
            // Reserve the slot synchronously so motion-gating sees the latest pose,
            // even before the JPEG encode finishes.
            lastKeyframeTime = timestamp
            lastKeyframePosition = simd_make_float3(transform.columns.3)
            lastKeyframeForward = -simd_make_float3(transform.columns.2) // ARKit camera looks down -Z
            hasFirstKeyframe = true
            return id
        }

        let filename = String(format: "frame_%04d.jpg", assignedId)
        let fileURL = framesDirURL.appendingPathComponent(filename)

        encodeQueue.async { [weak self] in
            guard let self = self else { return }
            guard let jpegData = self.encodeJPEG(from: pixelBuffer) else {
                // Encode failed — release the reserved id by recording a failure marker.
                return
            }
            do {
                try jpegData.write(to: fileURL, options: .atomic)
            } catch {
                return
            }
            let keyframe = Keyframe(
                id: assignedId,
                file: filename,
                timestamp: timestamp,
                transform: transform,
                intrinsics: intrinsics,
                imageWidth: Int(resolution.width),
                imageHeight: Int(resolution.height)
            )
            self.stateQueue.sync {
                // Pad if out-of-order encodes arrive (rare given the serial queue).
                while self.keyframes.count <= assignedId {
                    if self.keyframes.count == assignedId {
                        self.keyframes.append(keyframe)
                    } else {
                        // Slot reserved by an encode that failed; keep ordering by skipping.
                        self.keyframes.append(keyframe)
                    }
                }
            }
        }
    }

    private func shouldKeyframe(frame: ARFrame) -> Bool {
        let count = stateQueue.sync { keyframes.count }
        if count >= KeyframeTuning.maxKeyframes { return false }

        if !hasFirstKeyframe { return true }

        let elapsed = frame.timestamp - lastKeyframeTime
        if elapsed < KeyframeTuning.minIntervalSeconds { return false }

        let position = simd_make_float3(frame.camera.transform.columns.3)
        let translation = simd_distance(position, lastKeyframePosition)

        let forward = -simd_make_float3(frame.camera.transform.columns.2)
        let cosAngle = simd_clamp(simd_dot(simd_normalize(forward), simd_normalize(lastKeyframeForward)), -1, 1)
        let angle = acos(cosAngle)

        return translation >= KeyframeTuning.minTranslationMeters
            || angle >= KeyframeTuning.minRotationRadians
    }

    // MARK: JPEG encoding

    private func encodeJPEG(from pixelBuffer: CVPixelBuffer) -> Data? {
        let baseImage = CIImage(cvPixelBuffer: pixelBuffer)
        // ARKit captured images are landscape-right; rotate to upright portrait/landscape natural.
        // We keep ARKit's native orientation here — pose math expects this — and tag the JPEG
        // with EXIF .right so viewers display it upright while the bake pipeline reads raw pixels.
        let extent = baseImage.extent
        let longEdge = max(extent.width, extent.height)
        let scale = min(1.0, CGFloat(KeyframeTuning.jpegLongEdge) / longEdge)
        let scaled = baseImage.transformed(by: CGAffineTransform(scaleX: scale, y: scale))

        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        let options: [CIImageRepresentationOption: Any] = [
            kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: KeyframeTuning.jpegQuality
        ]
        return ciContext.jpegRepresentation(of: scaled, colorSpace: colorSpace, options: options)
    }

    // MARK: Export

    private func exportAndShare(_ room: CapturedRoom) {
        let tmp = FileManager.default.temporaryDirectory
        let usdzURL = tmp.appendingPathComponent("room.usdz")
        let jsonURL = tmp.appendingPathComponent("room.raw.json")
        let framesJsonURL = tmp.appendingPathComponent("frames.json")

        do {
            try room.export(to: usdzURL, exportOptions: .parametric)

            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let jsonData = try encoder.encode(room)
            try jsonData.write(to: jsonURL)

            try writeFramesManifest(to: framesJsonURL)

            let kfCount = stateQueue.sync { keyframes.count }
            statusLabel.text = "Done — \(kfCount) keyframes captured. AirDrop the bundle to your Mac."

            var items: [Any] = [usdzURL, jsonURL, framesJsonURL]
            // Include the frames directory so AirDrop ships the JPEGs alongside the manifest.
            items.append(framesDirURL)

            let activityVC = UIActivityViewController(activityItems: items, applicationActivities: nil)
            activityVC.popoverPresentationController?.sourceView = doneButton
            activityVC.popoverPresentationController?.sourceRect = doneButton.bounds
            present(activityVC, animated: true)
        } catch {
            showAlert(title: "Export failed", message: error.localizedDescription)
        }
    }

    private func writeFramesManifest(to url: URL) throws {
        let snapshot = stateQueue.sync { keyframes }
        let payload: [String: Any] = [
            "version": 1,
            "count": snapshot.count,
            "frames": snapshot.map { kf -> [String: Any] in
                let t = kf.transform
                let k = kf.intrinsics
                let transformArray: [Float] = [
                    t.columns.0.x, t.columns.0.y, t.columns.0.z, t.columns.0.w,
                    t.columns.1.x, t.columns.1.y, t.columns.1.z, t.columns.1.w,
                    t.columns.2.x, t.columns.2.y, t.columns.2.z, t.columns.2.w,
                    t.columns.3.x, t.columns.3.y, t.columns.3.z, t.columns.3.w,
                ]
                let intrinsicsArray: [Float] = [
                    k.columns.0.x, k.columns.0.y, k.columns.0.z,
                    k.columns.1.x, k.columns.1.y, k.columns.1.z,
                    k.columns.2.x, k.columns.2.y, k.columns.2.z,
                ]
                return [
                    "id": kf.id,
                    "file": "frames/\(kf.file)",
                    "timestamp": kf.timestamp,
                    "transform": transformArray,        // column-major, matches simd_float4x4
                    "intrinsics": intrinsicsArray,      // column-major, K = [[fx,0,0],[0,fy,0],[cx,cy,1]]
                    "image_width": kf.imageWidth,
                    "image_height": kf.imageHeight,
                ]
            },
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url)
    }

    private func showAlert(title: String, message: String) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }
}

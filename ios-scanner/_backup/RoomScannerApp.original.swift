// Single-file iOS RoomPlan scanner for soon2026.
//
// To use: create a new Xcode project (File → New → Project → iOS App → SwiftUI),
// replace the auto-generated RoomScannerApp.swift contents with this file,
// delete ContentView.swift, set deployment target to iOS 17.0, add the Info.plist
// key NSCameraUsageDescription (any short string), set the signing team, run.
//
// On Done: AirDrops room.usdz + room.raw.json off the device.

import SwiftUI
import RoomPlan
import UIKit

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

final class ScannerViewController: UIViewController, RoomCaptureViewDelegate, RoomCaptureSessionDelegate {

    private var captureView: RoomCaptureView!
    private let config = RoomCaptureSession.Configuration()
    private var doneButton: UIButton!
    private var statusLabel: UILabel!

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        setupCaptureView()
        setupOverlay()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        captureView.captureSession.run(configuration: config)
    }

    private func setupCaptureView() {
        captureView = RoomCaptureView(frame: view.bounds)
        captureView.captureSession.delegate = self
        captureView.delegate = self
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
        exportAndShare(processedResult)
    }

    // MARK: Export

    private func exportAndShare(_ room: CapturedRoom) {
        let tmp = FileManager.default.temporaryDirectory
        let usdzURL = tmp.appendingPathComponent("room.usdz")
        let jsonURL = tmp.appendingPathComponent("room.raw.json")

        do {
            try room.export(to: usdzURL, exportOptions: .parametric)

            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let jsonData = try encoder.encode(room)
            try jsonData.write(to: jsonURL)

            statusLabel.text = "Done — share these two files to your Mac via AirDrop."

            let activityVC = UIActivityViewController(activityItems: [usdzURL, jsonURL], applicationActivities: nil)
            activityVC.popoverPresentationController?.sourceView = doneButton
            activityVC.popoverPresentationController?.sourceRect = doneButton.bounds
            present(activityVC, animated: true)
        } catch {
            showAlert(title: "Export failed", message: error.localizedDescription)
        }
    }

    private func showAlert(title: String, message: String) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }
}

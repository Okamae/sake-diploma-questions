// 教本JPGをmacOS VisionでOCRし、テキストを標準出力に出す
// 使い方: swift ocr_textbook.swift <path-to-jpg>

import Foundation
import Vision
import AppKit

func ocrImage(at path: String) -> String {
    guard let nsImage = NSImage(contentsOfFile: path) else {
        return ""
    }
    guard let cgImage = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        return ""
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLanguages = ["ja-JP", "en-US"]
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return ""
    }
    guard let observations = request.results else { return "" }
    var lines: [String] = []
    for obs in observations {
        if let top = obs.topCandidates(1).first {
            lines.append(top.string)
        }
    }
    return lines.joined(separator: "\n")
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    print("Usage: swift ocr_textbook.swift <path-to-jpg>")
    exit(1)
}
let path = args[1]
print(ocrImage(at: path))

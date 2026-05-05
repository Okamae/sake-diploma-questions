// 教本252ページを一括OCRし、JSON で出力する
// 使い方: swift ocr_all_textbook.swift <textbook-dir> <output-json>

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
guard args.count >= 3 else {
    print("Usage: swift ocr_all_textbook.swift <textbook-dir> <output-json>")
    exit(1)
}
let dir = args[1]
let outPath = args[2]

let fm = FileManager.default
guard let files = try? fm.contentsOfDirectory(atPath: dir) else {
    print("Cannot read dir: \(dir)")
    exit(1)
}

let jpgs = files.filter { $0.hasSuffix(".jpg") }.sorted()
print("Found \(jpgs.count) JPG files")

var result: [String: String] = [:]
var processed = 0
let total = jpgs.count

for jpg in jpgs {
    let fullPath = (dir as NSString).appendingPathComponent(jpg)
    let text = ocrImage(at: fullPath)
    // ファイル名から page key を抽出: sake_diploma_p0011.jpg -> "11"
    var key = jpg
    if let m = jpg.range(of: #"p(\d{4})"#, options: .regularExpression) {
        let n = jpg[m].dropFirst() // remove leading "p"
        if let v = Int(n) {
            key = String(v)
        }
    } else if jpg.contains("hyoshi") {
        key = "cover"
    }
    result[key] = text
    processed += 1
    if processed % 10 == 0 || processed == total {
        FileHandle.standardError.write("Processed \(processed)/\(total)\n".data(using: .utf8)!)
    }
}

// JSON エンコード
do {
    let jsonData = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
    try jsonData.write(to: URL(fileURLWithPath: outPath))
    print("Written: \(outPath) (\(result.count) pages)")
} catch {
    print("Error writing JSON: \(error)")
    exit(1)
}

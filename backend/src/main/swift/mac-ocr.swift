// Local OCR bridge for macOS. Reads one JSON request line on stdin and writes one JSON line on stdout,
// matching the protocol of windows-ocr.ps1. Images never leave this computer.
import Foundation
import ImageIO
import Vision

struct BridgeError: Error { let code: String }

func writeJson(_ value: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: value)) ?? Data("{\"error\":\"OCR_FAILED\"}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func makeTextRequest() -> VNRecognizeTextRequest {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    return request
}

func preferredLanguage(_ languages: [String]) -> String {
    for prefix in ["zh-Hans", "zh-Hant", "en"] {
        if let match = languages.first(where: { $0 == prefix || $0.hasPrefix(prefix + "-") }) { return match }
    }
    return languages.first ?? ""
}

func integer(_ request: [String: Any], _ key: String) throws -> Int {
    guard let text = request[key] as? String, let value = Int(text) else { throw BridgeError(code: "INVALID_REGION") }
    return value
}

func recognize(_ request: [String: Any], languages: [String]) throws -> [String: Any] {
    guard !languages.isEmpty else { throw BridgeError(code: "NO_LANGUAGE") }
    var language = preferredLanguage(languages)
    if let requested = request["language"] as? String, !requested.isEmpty {
        guard languages.contains(requested) else { throw BridgeError(code: "UNSUPPORTED_LANGUAGE") }
        language = requested
    }
    guard let path = request["path"] as? String,
          let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw BridgeError(code: "OCR_FAILED") }
    let imageWidth = image.width, imageHeight = image.height
    var target = image
    var offsetX = 0, offsetY = 0, ocrWidth = imageWidth, ocrHeight = imageHeight
    if request["regionWidth"] != nil {
        offsetX = try integer(request, "regionX"); offsetY = try integer(request, "regionY")
        ocrWidth = try integer(request, "regionWidth"); ocrHeight = try integer(request, "regionHeight")
        guard offsetX >= 0, offsetY >= 0, ocrWidth >= 1, ocrHeight >= 1,
              offsetX + ocrWidth <= imageWidth, offsetY + ocrHeight <= imageHeight,
              let cropped = image.cropping(to: CGRect(x: offsetX, y: offsetY, width: ocrWidth, height: ocrHeight))
        else { throw BridgeError(code: "INVALID_REGION") }
        target = cropped
    }

    let textRequest = makeTextRequest()
    // Problem statements mix Chinese with English identifiers, so Chinese recognition also accepts English.
    var recognitionLanguages = [language]
    if language.hasPrefix("zh"), let english = languages.first(where: { $0 == "en-US" }) { recognitionLanguages.append(english) }
    textRequest.recognitionLanguages = recognitionLanguages
    try VNImageRequestHandler(cgImage: target, options: [:]).perform([textRequest])

    // Vision boxes are normalized with a bottom-left origin; the backend expects pixels from the top-left of the full image.
    func box(_ rect: CGRect) -> [String: Double] {
        let left = min(max(Double(offsetX) + rect.minX * Double(ocrWidth), 0), Double(imageWidth))
        let top = min(max(Double(offsetY) + (1 - rect.maxY) * Double(ocrHeight), 0), Double(imageHeight))
        let right = min(max(Double(offsetX) + rect.maxX * Double(ocrWidth), left), Double(imageWidth))
        let bottom = min(max(Double(offsetY) + (1 - rect.minY) * Double(ocrHeight), top), Double(imageHeight))
        return ["x": left, "y": top, "width": right - left, "height": bottom - top]
    }

    var lines: [[String: Any]] = []
    for observation in textRequest.results ?? [] {
        guard let candidate = observation.topCandidates(1).first else { continue }
        let text = candidate.string
        if text.trimmingCharacters(in: .whitespaces).isEmpty { continue }
        var words: [[String: Any]] = []
        var index = text.startIndex
        while index < text.endIndex {
            if text[index].isWhitespace { index = text.index(after: index); continue }
            var end = index
            while end < text.endIndex && !text[end].isWhitespace { end = text.index(after: end) }
            if let wordBox = try? candidate.boundingBox(for: index..<end) {
                var word: [String: Any] = box(wordBox.boundingBox)
                word["text"] = String(text[index..<end])
                words.append(word)
            }
            index = end
        }
        var line: [String: Any] = box(observation.boundingBox)
        line["text"] = text
        line["words"] = words
        lines.append(line)
    }
    return ["width": imageWidth, "height": imageHeight, "language": language, "lines": lines]
}

do {
    guard let input = readLine(),
          let request = try JSONSerialization.jsonObject(with: Data(input.utf8)) as? [String: Any] else {
        throw BridgeError(code: "OCR_FAILED")
    }
    let languages = (try? makeTextRequest().supportedRecognitionLanguages()) ?? []
    switch request["operation"] as? String {
    case "status":
        let names = Locale(identifier: "zh-Hans")
        writeJson([
            "available": !languages.isEmpty,
            "languages": languages.map { ["tag": $0, "name": names.localizedString(forIdentifier: $0) ?? $0] },
            "defaultLanguage": preferredLanguage(languages),
            // Vision downsamples large images itself; this mirrors the upload limit used elsewhere.
            "maxImageDimension": 16384,
        ])
    case "recognize":
        writeJson(try recognize(request, languages: languages))
    default:
        throw BridgeError(code: "OCR_FAILED")
    }
} catch let error as BridgeError {
    writeJson(["error": error.code == "INVALID_REGION" ? "OCR_FAILED" : error.code])
} catch {
    writeJson(["error": "OCR_FAILED"])
}

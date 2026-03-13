#!/usr/bin/env swift

import AppKit

guard CommandLine.arguments.count == 3 else {
  fputs("Usage: render-tray-template.swift <source-png> <output-png>\n", stderr)
  exit(1)
}

let sourceURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
let canvasSize = CGFloat(64)

guard let sourceImage = NSImage(contentsOf: sourceURL) else {
  fputs("Unable to load source image at \(sourceURL.path)\n", stderr)
  exit(1)
}

guard let bitmap = NSBitmapImageRep(
  bitmapDataPlanes: nil,
  pixelsWide: Int(canvasSize),
  pixelsHigh: Int(canvasSize),
  bitsPerSample: 8,
  samplesPerPixel: 4,
  hasAlpha: true,
  isPlanar: false,
  colorSpaceName: .deviceRGB,
  bytesPerRow: 0,
  bitsPerPixel: 0
) else {
  fputs("Unable to allocate bitmap\n", stderr)
  exit(1)
}

bitmap.size = NSSize(width: canvasSize, height: canvasSize)

NSGraphicsContext.saveGraphicsState()
guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
  fputs("Unable to create graphics context\n", stderr)
  exit(1)
}
NSGraphicsContext.current = context
context.cgContext.interpolationQuality = .high

let canvasRect = NSRect(x: 0, y: 0, width: canvasSize, height: canvasSize)
NSColor.clear.setFill()
canvasRect.fill()

let markSize = canvasSize * 0.52
let markRect = NSRect(
  x: (canvasSize - markSize) / 2,
  y: (canvasSize - markSize) / 2,
  width: markSize,
  height: markSize
)

sourceImage.draw(in: markRect, from: .zero, operation: .sourceOver, fraction: 1.0)

NSColor.black.setFill()
canvasRect.fill(using: .sourceIn)

NSGraphicsContext.restoreGraphicsState()

guard let pngData = bitmap.representation(using: .png, properties: [:]) else {
  fputs("Unable to encode PNG\n", stderr)
  exit(1)
}

do {
  try pngData.write(to: outputURL)
} catch {
  fputs("Unable to write PNG to \(outputURL.path): \(error)\n", stderr)
  exit(1)
}

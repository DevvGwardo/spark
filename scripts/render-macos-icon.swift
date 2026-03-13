#!/usr/bin/env swift

import AppKit

func color(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat, _ alpha: CGFloat = 1.0) -> NSColor {
  NSColor(
    calibratedRed: red / 255.0,
    green: green / 255.0,
    blue: blue / 255.0,
    alpha: alpha
  )
}

guard CommandLine.arguments.count == 3 else {
  fputs("Usage: render-macos-icon.swift <source-png> <output-png>\n", stderr)
  exit(1)
}

let sourceURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
let canvasSize = CGFloat(1024)

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

let plateInset = canvasSize * 0.10
let plateRect = canvasRect.insetBy(dx: plateInset, dy: plateInset)
let plateRadius = canvasSize * 0.23
let platePath = NSBezierPath(roundedRect: plateRect, xRadius: plateRadius, yRadius: plateRadius)

context.cgContext.saveGState()
let plateShadow = NSShadow()
plateShadow.shadowColor = color(32, 10, 8, 0.28)
plateShadow.shadowBlurRadius = canvasSize * 0.07
plateShadow.shadowOffset = NSSize(width: 0, height: -(canvasSize * 0.035))
plateShadow.set()
color(67, 22, 19).setFill()
platePath.fill()
context.cgContext.restoreGState()

platePath.addClip()

let plateGradient = NSGradient(colors: [
  color(88, 32, 24),
  color(155, 54, 37),
  color(78, 24, 31)
])
plateGradient?.draw(
  in: platePath,
  angle: -55
)

let glowRect = plateRect.insetBy(dx: -canvasSize * 0.06, dy: -canvasSize * 0.06)
let glowGradient = NSGradient(colors: [
  color(255, 214, 135, 0.52),
  color(255, 155, 77, 0.24),
  color(255, 112, 33, 0.0)
])
glowGradient?.draw(
  in: NSBezierPath(ovalIn: glowRect),
  relativeCenterPosition: NSZeroPoint
)

let topGlossRect = NSRect(
  x: plateRect.minX,
  y: plateRect.midY,
  width: plateRect.width,
  height: plateRect.height * 0.58
)
let topGlossPath = NSBezierPath(roundedRect: topGlossRect, xRadius: plateRadius, yRadius: plateRadius)
let topGlossGradient = NSGradient(colors: [
  color(255, 255, 255, 0.28),
  color(255, 255, 255, 0.10),
  color(255, 255, 255, 0.0)
])
topGlossGradient?.draw(in: topGlossPath, angle: -90)

let innerShadowPath = NSBezierPath(roundedRect: plateRect.insetBy(dx: 8, dy: 8), xRadius: plateRadius - 8, yRadius: plateRadius - 8)
color(255, 255, 255, 0.24).setStroke()
innerShadowPath.lineWidth = canvasSize * 0.008
innerShadowPath.stroke()

let outerStrokePath = NSBezierPath(roundedRect: plateRect.insetBy(dx: 3, dy: 3), xRadius: plateRadius - 3, yRadius: plateRadius - 3)
color(255, 199, 146, 0.38).setStroke()
outerStrokePath.lineWidth = canvasSize * 0.005
outerStrokePath.stroke()

NSGraphicsContext.restoreGraphicsState()
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context

let markShadow = NSShadow()
markShadow.shadowColor = color(92, 19, 22, 0.22)
markShadow.shadowBlurRadius = canvasSize * 0.045
markShadow.shadowOffset = NSSize(width: 0, height: -(canvasSize * 0.02))
markShadow.set()

let markSize = canvasSize * 0.72
let markRect = NSRect(
  x: (canvasSize - markSize) / 2,
  y: (canvasSize - markSize) / 2 + canvasSize * 0.01,
  width: markSize,
  height: markSize
)
sourceImage.draw(in: markRect, from: .zero, operation: .sourceOver, fraction: 1.0)

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

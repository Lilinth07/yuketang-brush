import Cocoa
let folder = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let image = NSImage(size: NSSize(width: pixels, height: pixels))
        image.lockFocus()
        let p = CGFloat(pixels)
        let rect = NSRect(x: p * 0.05, y: p * 0.05, width: p * 0.9, height: p * 0.9)
        NSColor(calibratedRed: 0.12, green: 0.31, blue: 0.57, alpha: 1).setFill()
        NSBezierPath(roundedRect: rect, xRadius: p * 0.2, yRadius: p * 0.2).fill()
        NSColor.white.setFill()
        let book = NSRect(x: p * 0.26, y: p * 0.18, width: p * 0.49, height: p * 0.65)
        NSBezierPath(roundedRect: book, xRadius: p * 0.045, yRadius: p * 0.045).fill()
        NSColor(calibratedRed: 0.12, green: 0.31, blue: 0.57, alpha: 1).setStroke()
        let spine = NSBezierPath()
        spine.lineWidth = p * 0.022
        spine.move(to: NSPoint(x: p * 0.34, y: p * 0.29))
        spine.line(to: NSPoint(x: p * 0.34, y: p * 0.78))
        spine.stroke()
        let pages = NSBezierPath()
        pages.lineWidth = p * 0.018
        pages.move(to: NSPoint(x: p * 0.32, y: p * 0.25))
        pages.line(to: NSPoint(x: p * 0.70, y: p * 0.25))
        pages.stroke()
        NSColor(calibratedRed: 0.95, green: 0.65, blue: 0.27, alpha: 1).setFill()
        NSRect(x: p * 0.59, y: p * 0.57, width: p * 0.065, height: p * 0.26).fill()
        image.unlockFocus()
        let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
        let name = "icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"
        try rep.representation(using: .png, properties: [:])!.write(to: folder.appendingPathComponent(name))
    }
}

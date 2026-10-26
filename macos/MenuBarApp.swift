import Cocoa
import Darwin

let smokeTest = CommandLine.arguments.contains("--smoke-test")
let serviceURL = URL(string: "http://127.0.0.1:7788")!

final class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var stateItem: NSMenuItem!
    var service: Process?
    var input: Pipe?
    var logHandle: FileHandle?
    var timer: Timer?
    var checking = false
    var quitting = false
    var ready = false
    var attempts = 0
    let fm = FileManager.default
    let data: URL = {
        if let path = Bundle.main.object(forInfoDictionaryKey: "YuketangDataDirectory") as? String, !path.isEmpty {
            return URL(fileURLWithPath: (path as NSString).expandingTildeInPath, isDirectory: true)
        }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("yuketang-brush", isDirectory: true)
    }()
    var project: URL { Bundle.main.resourceURL!.appendingPathComponent("project", isDirectory: true) }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if !smokeTest, let identifier = Bundle.main.bundleIdentifier,
           NSRunningApplication.runningApplications(withBundleIdentifier: identifier).contains(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            NSWorkspace.shared.open(serviceURL)
            NSApp.terminate(nil)
            return
        }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "book.closed", accessibilityDescription: "雨课堂")
        statusItem.button?.image?.isTemplate = true
        statusItem.button?.toolTip = "雨课堂 · 正在启动"
        let menu = NSMenu()
        stateItem = NSMenuItem(title: "服务正在启动…", action: nil, keyEquivalent: "")
        menu.addItem(stateItem)
        menu.addItem(.separator())
        add(menu, "打开网页", #selector(openPage), "o")
        add(menu, "初始化 / 添加课程…", #selector(setupCourse))
        add(menu, "打开数据文件夹", #selector(openData))
        add(menu, "查看服务日志", #selector(openLog))
        menu.addItem(.separator())
        add(menu, "重新启动服务", #selector(restart))
        add(menu, "退出雨课堂", #selector(quit), "q")
        statusItem.menu = menu
        do {
            try fm.createDirectory(at: data, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            start()
        } catch { fail("无法准备数据目录：\(error.localizedDescription)") }
    }

    func add(_ menu: NSMenu, _ title: String, _ action: Selector, _ key: String = "") {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        menu.addItem(item)
    }

    func environment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = project.appendingPathComponent(".runtime/node/bin").path + ":/usr/bin:/bin:/usr/sbin:/sbin"
        env["PLAYWRIGHT_BROWSERS_PATH"] = project.appendingPathComponent(".runtime/browsers").path
        env["BROWSER_CHANNEL"] = "chromium"
        env["YUKETANG_DATA_DIR"] = data.path
        env["YUKETANG_APP_MANAGED"] = "1"
        env["UI_PORT"] = "7788"
        return env
    }

    func start() {
        guard service == nil else { return }
        ready = false
        attempts = 0
        stateItem.title = "服务正在启动…"
        let process = Process()
        process.executableURL = Bundle.main.executableURL!.deletingLastPathComponent().appendingPathComponent("service-launcher")
        process.arguments = [project.appendingPathComponent(".runtime/node/bin/node").path, project.appendingPathComponent("src/server.mjs").path]
        process.currentDirectoryURL = project
        process.environment = environment()
        let pipe = Pipe()
        input = pipe
        process.standardInput = pipe
        let logURL = data.appendingPathComponent("服务日志.log")
        if !fm.fileExists(atPath: logURL.path) { fm.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
        do {
            let handle = try FileHandle(forWritingTo: logURL)
            try handle.seekToEnd()
            logHandle = handle
            process.standardOutput = handle
            process.standardError = handle
            process.terminationHandler = { [weak self] ended in
                DispatchQueue.main.async {
                    guard let self = self, self.service === ended, !self.quitting else { return }
                    self.timer?.invalidate()
                    self.service = nil
                    self.ready = false
                    self.stateItem.title = "服务已停止"
                    self.statusItem.button?.toolTip = "雨课堂 · 服务已停止"
                    if ended.terminationStatus != 0 { self.fail("服务启动失败。端口 7788 可能已被占用，请查看服务日志。") }
                }
            }
            try process.run()
            service = process
            timer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in self?.checkReady() }
        } catch { fail("启动失败：\(error.localizedDescription)") }
    }

    func checkReady() {
        guard !checking, let process = service, process.isRunning else { return }
        checking = true
        attempts += 1
        var request = URLRequest(url: serviceURL.appendingPathComponent("api/health"))
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.checking = false
                guard self.service === process, !self.quitting else { return }
                if let response = response as? HTTPURLResponse, response.statusCode == 200, data != nil, response.value(forHTTPHeaderField: "X-Yuketang-Service-Pid") == String(process.processIdentifier) {
                    self.timer?.invalidate()
                    self.ready = true
                    self.stateItem.title = "服务运行中 · 127.0.0.1:7788"
                    self.statusItem.button?.toolTip = "雨课堂 · 服务运行中"
                    if smokeTest {
                        print("APP_READY pid=\(process.processIdentifier) data=\(self.data.path)")
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { NSApp.terminate(nil) }
                    } else { self.openPage() }
                } else if self.attempts > 30 {
                    self.timer?.invalidate()
                    self.stop()
                    self.fail("服务未能启动，请从菜单查看服务日志。")
                }
            }
        }.resume()
    }

    func stop() {
        timer?.invalidate()
        let process = service
        service = nil
        ready = false
        try? input?.fileHandleForWriting.close()
        input = nil
        if let process = process, process.isRunning {
            let pid = process.processIdentifier
            kill(-pid, SIGTERM)
            let limit = Date().addingTimeInterval(4)
            while process.isRunning && Date() < limit { Thread.sleep(forTimeInterval: 0.05) }
            // Also remove remaining browser/task descendants in the owned process group.
            kill(-pid, SIGKILL)
        }
        try? logHandle?.close()
        logHandle = nil
    }

    func fail(_ message: String) {
        stateItem.title = "服务未运行 · 请查看日志"
        if smokeTest { fputs("APP_FAILED: \(message)\n", stderr); NSApp.terminate(nil); return }
        let alert = NSAlert()
        alert.messageText = "雨课堂"
        alert.informativeText = message
        alert.runModal()
    }

    @objc func openPage() { if ready { NSWorkspace.shared.open(serviceURL) } }
    @objc func openData() { NSWorkspace.shared.open(data) }
    @objc func openLog() { NSWorkspace.shared.open(data.appendingPathComponent("服务日志.log")) }
    @objc func restart() { stop(); start() }
    @objc func quit() { NSApp.terminate(nil) }
    @objc func setupCourse() {
        if ready { NSWorkspace.shared.open(URL(string: "http://127.0.0.1:7788/#serviceTerminal")!) }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { openPage(); return false }
    func applicationWillTerminate(_ notification: Notification) { quitting = true; stop() }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()

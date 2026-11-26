# macOS 使用与 App 构建

## 双击使用

下载源码后双击 `打开网页.command` 或 `启动.command`。首次运行会从 Node.js 官方下载并校验独立运行环境，再安装锁定的 JavaScript 依赖。

菜单栏 App 首次启动用 macOS 默认浏览器打开本地网页，随后从本机已安装的浏览器中选择。以后可在书本图标菜单的「设置…」中更改，应用内的选择不改变 macOS 默认浏览器。

登录和课程扫描使用机器上已有的 EgoLite、Google Chrome 或 Microsoft Edge。EgoLite 可复用已登录的会话，Chrome 和 Edge 使用雨课堂 App 独立的浏览器资料目录。首次登录按服务终端提示操作。

## 网页服务终端

在网页点击「扫描课程」，或运行 `npm run setup`。登录后会扫描课表并读取当前课程的章节目录。首次扫描默认选择第一门。要刷新其他课程，先在网页顶部的下拉框里切换，再点「扫描课程」。可隐藏密钥输入、中断当前命令，并在刷新网页后恢复最近输出。

终端执行本项目预设的 `npm run` 命令，支持 `--` 后的参数和带引号的网址。它不调用系统 Shell；管道、重定向和通用 Shell 命令不在支持范围内。一次只运行一个任务；GUI 按钮和终端共用同一把任务锁。仅在内存保留最近 200,000 字符，重启服务后清空。

## 构建菜单栏 App

需要 macOS 13.5+ 与 Xcode Command Line Tools。安装开发工具后执行：

```bash
bash scripts/build-mac-app.sh
```

生成的 `dist/雨课堂.app` 包含当前架构的独立 Node、Playwright 驱动和项目源码，可拖入「应用程序」。打开后自动启动 `127.0.0.1:7788` 并打开本地服务网页；菜单栏显示书本图标，可重新打开网页、进入课程初始化、查看日志、重启或退出。

关闭网页不会停止服务。退出 App 会终止服务及其任务进程组；App 意外退出时，服务也会收到输入管道关闭通知并清理任务。端口已被占用时会报错，不会接管或终止其他进程。

App 的数据默认放在 `~/Library/Application Support/yuketang-brush`，与程序分开存放。源码命令行仍默认把数据保存在源码目录，可通过 `YUKETANG_DATA_DIR` 指定位置。构建时可用 `YUKETANG_APP_DATA_DIR` 指定 App 的数据目录，例如：

```bash
YUKETANG_APP_DATA_DIR="$HOME/Documents/yuketang-data" bash scripts/build-mac-app.sh
```

构建仅复制源码、锁定的依赖和 Node 运行环境，不复制 `config.local.json`、`.profile`、Cookie 或日志。不要分享数据目录。构建产物、运行环境和个人数据均不应提交到 Git。

脚本采用本机临时签名，不包含开发者证书和 Apple 公证。公开发布可下载 App 时，发布者需自行完成分发签名、公证和相应许可审查。发布构建时应取消 `YUKETANG_APP_DATA_DIR` 覆盖。

## 验证

```bash
npm ci
npm test
```

自动测试使用临时目录与本机测试服务，验证真实命令交互、并发限制、中断、Origin 校验和配置保留，不登录平台、不修改课程进度、不提交作业。真实扫码和平台接口仍需本人验证。

# macOS 使用与 App 构建

## 双击使用

下载源码后双击 `打开网页.command` 或 `启动.command`。首次会从 Node.js 官方下载并校验独立运行环境、安装锁定依赖和 Playwright 配套浏览器；后续复用。支持 Apple 芯片与 Intel Mac，不修改系统 Node 或默认浏览器。

专用浏览器的应用名是 **Google Chrome for Testing**。它只用于登录、课程初始化和需要页面处理的功能，安装在项目的 `.runtime/browsers` 内，不会替换系统浏览器。网页界面可以在 Safari 中使用。系统 Safari 不作为自动化浏览器，不需要打开 Safari 的远程自动化设置。

## 网页服务终端

在网页点击「初始化课程」，或运行 `npm run setup`。课程网址、菜单序号等通过下方回复框发送；空内容发送表示回车。可隐藏密钥输入、中断当前命令，并在刷新网页后恢复最近输出。

终端执行本项目预设的 `npm run` 命令，支持 `--` 后的参数和带引号的网址。它不调用系统 Shell；管道、重定向和通用 Shell 命令不在支持范围内。一次只运行一个任务；GUI 按钮和终端共用同一把任务锁。仅在内存保留最近 200,000 字符，重启服务后清空。

## 构建菜单栏 App

需要 macOS 13+ 与 Xcode Command Line Tools。安装开发工具后执行：

```bash
bash scripts/build-mac-app.sh
```

生成的 `dist/雨课堂.app` 包含当前架构的独立 Node、依赖和专用浏览器，可拖入「应用程序」。打开后自动启动 `127.0.0.1:7788` 并在默认浏览器打开页面；菜单栏显示书本图标，可重新打开网页、进入课程初始化、查看日志、重启或退出。

关闭网页不会停止服务。退出 App 会终止服务及其任务进程组；App 意外退出时，服务也会收到输入管道关闭通知并清理任务。端口已被占用时会报错，不会接管或终止其他进程。

App 的数据默认放在 `~/Library/Application Support/yuketang-brush`，与程序分开存放。源码命令行仍默认把数据保存在源码目录，可通过 `YUKETANG_DATA_DIR` 指定位置。构建时可用 `YUKETANG_APP_DATA_DIR` 指定 App 的数据目录，例如：

```bash
YUKETANG_APP_DATA_DIR="$HOME/Documents/yuketang-data" bash scripts/build-mac-app.sh
```

构建仅复制源码、依赖和运行环境，不复制 `config.local.json`、`.profile`、Cookie 或日志。不要分享数据目录。构建产物、运行环境和个人数据均不应提交到 Git。

脚本采用本机临时签名，不包含开发者证书和 Apple 公证。公开发布可下载 App 时，发布者需自行完成分发签名、公证和相应许可审查；本 PR 不附带二进制或个人账号数据。

## 验证

```bash
npm ci
npm test
```

自动测试使用临时目录与本机测试服务，验证真实命令交互、并发限制、中断、Origin 校验和配置保留，不登录平台、不修改课程进度、不提交作业。真实扫码和平台接口仍需本人验证。

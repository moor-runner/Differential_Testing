# 对拍工作台

面向 Windows 10/11 的本地 Java 对拍桌面应用。题目列表、Markdown 题面、生成器 / 暴力解 / 优化解和结果同屏显示。支持截图粘贴与拖入、LaTeX、可保存的拖动分栏、批量对拍、停止、反例 Diff、种子复现和历史快照。

技术栈：Electron、React、TypeScript、Monaco、KaTeX；Spring Boot、MyBatis、SQLite；JDK 21。

## 运行桌面版本

需要本机安装完整 **JDK 21**，并设置 `JAVA_HOME` 或使 `java` 与 `javac` 位于 PATH。后端和用户代码共用此 JDK。应用运行时资源全部本地打包，无需联网。

构建出的便携程序为 `release/Duipai-1.0.1-win-x64.exe`，双击打开。未进行商业代码签名。数据默认保存在 `%APPDATA%/duipai-workbench/data`；状态栏可打开数据目录。退出应用后复制整个目录即可备份。

可设置 `DUIPAI_JAVA_HOME` 指定 JDK，`DUIPAI_DATA_DIR` 指定数据目录。种子为 signed 64-bit 十进制整数，留空则随机。

此前使用项目 `data` 目录的用户，可先关闭旧窗口，再双击项目根目录的 `启动工作台.cmd`。它启动新版便携程序并继续使用当前项目数据和配置目录。

## 从源码开发

需要 Node.js 22.12+、npm、Maven 3.9+ 和 JDK 21。

```powershell
npm run setup
npm run build
npm start
```

`npm run dev` 重新构建并启动桌面工作台。开发数据保存在项目 `data` 目录，缓存位于 `.cache`。前端独立开发可设置 `DUIPAI_BACKEND_URL` 和 `DUIPAI_TOKEN`，然后执行 `npm --prefix frontend run dev`；后端同时需设置 `DUIPAI_DEV_ORIGIN=http://127.0.0.1:5173`。

```powershell
npm test                 # TypeScript + 前端构建 + 后端 JUnit 测试
npm run test:acceptance   # 使用真实 JVM/SQLite 的完整后端验收
npm run test:desktop      # Electron 界面、关闭与重启测试
npm run test:portable     # 实际便携 EXE 启动、对拍与退出验收
npm run test:images       # 文件选择插图、尺寸适配、取消与超时回归
npm run package          # 构建 Windows x64 便携程序
```

首次安装依赖和打包工具需要网络；交付版本运行无需网络。`npm run package:dir` 生成可直接运行的目录版。

## 使用

1. 新建题目，输入题面或粘贴截图。新题自带可运行的三份 `public class Main` 模板，生成器从 `args[0]` 读取种子。
2. 设置最大轮数（默认 1000）、起始种子和并行度。三个时限分别默认 5 / 10 / 2 秒。
3. 开始对拍。任务开始前保存当前题面、代码和参数；停止输入 1 秒后也会自动保存。
4. 找到反例后查看种子、输入、两边输出差异及错误详情。修改代码后点击复现，验证同一轮是否已修复。
5. 历史记录可查看当时的反例与代码快照，再用当前代码复现。

点击题面底部的图片按钮选择 PNG/JPEG/GIF，保存完成后直接显示预览。点击图片打开大图：窗口根据原图分辨率调整，大图按比例缩小到屏幕内，小图保持原始大小；可切换“原始尺寸”滚动查看。上传支持取消，无响应时 30 秒超时并恢复按钮。更新到 1.0.1 后请关闭旧窗口再重新启动，现有题目和图片保留在原数据目录。

开发构建输出位于 `.cache/backend-build`。每次启动都会将后端复制到独立运行目录，因此再次构建不会替换运行中的 JAR。

并行任务取最先检测到的失败，不保证其种子是所有轮次中最小的失败种子。每个程序每轮新启一个 JVM；时限包含 JVM 启动。Java 堆最大 128 MiB，stdout 捕获上限 8 MiB，stderr 上限 1 MiB。单块内容在界面显示前 1 MiB，可导出全部已捕获内容。超出执行上限的输出不继续保留。

本工具用于自己信任的本地 Java 代码，不包含操作系统沙箱。v1 范围只支持 Java、普通逐行答案比较；不含 SPJ、浮点容差、交互题、AI 或多用户功能。

完整 [设计说明](docs/DESIGN.md)、[接口协议](docs/CONTRACT.md) 与 [22 项需求验收记录](docs/ACCEPTANCE.md) 位于 docs。

![实际桌面运行截图](docs/workbench.png)

# dsh-video-notes

把「B 站视频 → Markdown 笔记」做成 DeepSeek Harness 插件。装上后，在 DSH 对话框里直接让模型调用 `video_to_notes` 工具即可：下载视频 → whisper 本地转写 → DSH 自身大模型整理成结构化笔记 → 落盘。全程不用填 API key。

## 它做什么

一次调用完成四步：

1. `yt-dlp` 下载 B 站视频（免登录最高 1080p，支持合集分 P）
2. `ffmpeg` 抽音轨（16 kHz 单声道）
3. `whisper.cpp` 本地转写（中文）
4. DSH 自带 LLM 把转写稿整理成结构化 Markdown 笔记（视频信息表 / 一句话总结 / 带时间戳分节 / 易错点 / 术语中英对照 / 自测题 / 时间轴 / 衔接）

生成的笔记默认**同时转成 PDF**（用本机 Edge/Chrome 无头打印渲染，同目录同名 `.pdf`）。产出的笔记落盘到桌面 `宋浩高数笔记` 目录（可在插件设置里改）。

## 安装

### 从插件市场安装（推荐，上架后）

在 DSH 的插件市场里搜索 `dsh-video-notes` 一键安装即可。

### 从 GitHub 源码安装

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "C:\...\DeepSeek Harness.exe" install-dsh-plugin.mjs add "github:5530-ok/5530"
```

安装脚本 `install-dsh-plugin.mjs` 位于 DSH 的 dsh 目录（`app.asar\dsh\` 下），会走 `dsh plugin --profile desktop add <spec>` 把插件装进 desktop profile。

### 本地目录安装

把本目录（整个 `dsh-video-notes` 文件夹，含 `lib/`、`package.json`、`cordis.patch.yml`）放到目标电脑上，然后：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "C:\...\DeepSeek Harness.exe" install-dsh-plugin.mjs add "file:///C:/path/to/dsh-video-notes"
```

> 安装后需要手动把 `dsh-video-notes` 加进 profile 的 `dsh.profile.bundles`，或在 DSH 界面里按一次刷新按钮，让插件加载。

## 依赖自动下载（其他电脑首次用）

插件会自动检测四个工具，本机没有时自动下载到 `~/.dsh/video-notes/`（数据目录，可在设置里改）：

| 依赖 | 检测顺序 | 下载源 |
|---|---|---|
| yt-dlp | 设置路径 → PATH → 数据目录 → WinGet | GitHub releases |
| ffmpeg | 设置路径 → PATH → 数据目录 → WinGet | gyan.dev essentials 静态版 |
| whisper-cli | 设置路径 → 数据目录 | GitHub whisper.cpp CI 二进制（b5454 x64） |
| whisper 模型 | 设置路径 → 数据目录 | hf-mirror.com（国内镜像，约 547 MB，仅首次） |

首次使用会花几分钟下载模型和二进制，之后复用。

## 配置

插件设置项（在 DSH 设置面板里可改）：

- `notesDir` — 笔记保存目录（默认 `桌面\宋浩高数笔记`）
- `mediaDir` — 视频下载临时目录（默认 `~/.dsh/video-notes/media`）
- `dataDir` — 转写依赖下载目录（默认 `~/.dsh/video-notes`）
- `notePrefix` — 笔记文件名前缀（默认 `宋浩`）
- `language` — 转写语言（默认 `zh`）
- `threads` — whisper 转写线程数（默认核数 − 4）
- `keepVideo` — 是否保留下载的视频与音轨（默认 `false`，转写完即删）
- `provider` / `model` — 笔记生成用 LLM（默认 `deepseek-official` / `deepseek-flash`）
- `temperature` — 生成温度（默认 0.3）
- `pdf` — 是否同时生成 PDF（默认 `true`）
- `browserPath` — Edge/Chrome 可执行文件显式路径（留空自动检测）
- `ytdlpPath` / `ffmpegPath` / `whisperPath` / `modelPath` — 显式路径覆盖（留空自动检测）

## 工具调用示例

```
video_to_notes(url="https://www.bilibili.com/video/BVxxxx/?p=3")
```

返回笔记全文，并落盘一份 `.md` 文件 + 一份同目录同名的 `.pdf` 文件。

只把已有笔记转 PDF：

```
note_to_pdf(mdPath="C:\\Users\\...\\笔记.md")
```

## 许可

[MIT](LICENSE)

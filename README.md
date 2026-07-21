# Emby Segment Loop

视频片段截取与循环播放插件，适用于 Emby Server 4.9.x。

## 功能概述

- **快捷键截取片段**：播放中按开始/结束快捷键截取视频片段，默认 `[` 开始、`]` 结束。
- **片段编辑**：在视频详情页修改片段名称、开始时间、结束时间（精确到毫秒）。
- **循环播放**：点击详情页或播放界面进度条下方的片段按钮，直接跳转并循环播放该片段，再次点击取消。
- **服务端存储**：片段数据持久化到 SQLite 数据库，支持自定义存储路径。
- **插件设置页**：在 Emby 插件设置中配置快捷键。

## 项目结构

```
EmbySegmentLoop/
├── EmbySegmentLoop.csproj    # 项目文件 (.NET 8)
├── Plugin.cs                 # 插件主类 + 配置模型
├── EntryPoint.cs             # 启动入口：初始化片段数据库
├── ConfigurationPage.cs      # 插件设置页 HTML
├── SegmentRepository.cs      # SQLite 数据库操作 (P/Invoke)
├── SegmentLoopService.cs     # REST API：片段的 GET/POST
├── segmentloop.js            # 前端脚本（嵌入 DLL 资源）
├── build_linux_dashboard.py # 从 Emby DEB 生成原版/注入版 UI 文件
├── linux-dashboard/         # Emby 4.9.5.0 原版与可直接覆盖的注入版
├── build-release.ps1         # 构建+打包脚本
├── .gitignore
└── README.md
```

## 环境要求

| 依赖 | 说明 |
|------|------|
| Emby Server | 4.9.x |
| .NET SDK | 8.0 |
| Windows / Linux | .NET 8；Linux 前端文件基于 Emby 4.9.5.0 DEB |

## 快速构建

### 1. 安装 .NET 8 SDK

下载地址：https://dotnet.microsoft.com/download/dotnet/8.0

### 2. 配置依赖引用路径

`EmbySegmentLoop.csproj` 中的 HintPath 指向 Emby Server 的 `system` 目录：

```xml
<HintPath>..\..\system\MediaBrowser.Common.dll</HintPath>
<HintPath>..\..\system\MediaBrowser.Controller.dll</HintPath>
<HintPath>..\..\system\MediaBrowser.Model.dll</HintPath>
```

如果你的 Emby Server 不在 `..\..\system`，请修改为实际路径。

### 3. 构建

```powershell
# 方式一：使用构建脚本（生成 ZIP 发布包）
.\build-release.ps1

# 方式二：直接 dotnet publish
dotnet publish -c Release -o .\publish
```

`build-release.ps1` 会自动检测 `T:\dotnet-sdk-8.0.422-win-x64\dotnet.exe`，找不到时回退到系统 PATH 中的 `dotnet`。

构建产物：
- `release\Emby.Plugins.SegmentLoop.dll` — 插件 DLL
- `release\dashboard-ui` — 可直接覆盖的 Linux dashboard 文件
- `Emby.Plugins.SegmentLoop-{version}.zip` — 发布包

当 `T:\emby-server-deb_4.9.5.0_amd64.deb` 存在时，构建脚本会先重新生成
`linux-dashboard/4.9.5.0/original` 和 `injected`，避免在历史上已修改的
Emby 文件上继续叠加注入。

## 安装

### Linux（Emby 4.9.5.0）

1. 停止 `emby-server`。
2. 将 DLL 覆盖到 `/var/lib/emby/plugins/Emby.Plugins.SegmentLoop.dll`。
3. 用 `release/dashboard-ui/index.html` 覆盖
   `/opt/emby-server/system/dashboard-ui/index.html`。
4. 用 `release/dashboard-ui/item/item.js` 覆盖
   `/opt/emby-server/system/dashboard-ui/item/item.js`。
5. 启动 `emby-server`，然后强制刷新 Web 客户端。

也可使用 `sudo bash install-debian.sh`。脚本会下载并直接覆盖已生成
的注入版文件，不再在 NAS 上用 `sed` 或临时 Python 修改 UI。

### Windows / ZIP 发布包

1. 解压 ZIP，将 `Emby.Plugins.SegmentLoop.dll` 复制到 Emby Server 的 `programdata\plugins` 目录。
2. 重启 Emby Server。

### 方式二：开发者直接安装

```powershell
Copy-Item .\release\Emby.Plugins.SegmentLoop.dll -Destination "<Emby目录>\programdata\plugins" -Force
```

然后重启 Emby Server。

## 工作原理

### 插件启动

`EntryPoint.Run()` 在 Emby 启动时执行：

`EntryPoint.Run()` 只初始化 SQLite 数据库，不再修改 Emby 系统文件。
前端文件由发布包或 Linux 安装脚本直接覆盖，避免 Emby 运行用户
没有 `/opt/emby-server/system` 写权限时出现“日志显示完成但实际未更新”。

### 前端注入

- `original`：从指定 Emby DEB 逐字节提取的原文件。
- `injected`：仅在原文件上注入 `segmentloop.js` 和详情页 render hook。
- `manifest.json`：记录 DEB、原文件和注入文件的 SHA-256。
- 快捷键配置由前端通过 Emby 插件配置 API 读取，不需要改写 `index.html`。

### 数据存储

- **后端**：片段数据存储在 SQLite 数据库（默认路径 `programdata\metadata\segmentloop\segments.db`）。
- **前端**：使用浏览器 `localStorage` 缓存当前播放状态。
- **REST API**：
  - `GET /SegmentLoop/Segments/{ItemId}` — 获取视频的片段列表
  - `POST /SegmentLoop/Segments/{ItemId}` — 保存视频的片段列表

## 插件设置

在 Emby 管理控制台 → 插件 → Segment Loop 中配置：

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| 片段开始快捷键 | `[` | 播放时按下标记片段起始点 |
| 片段结束快捷键 | `]` | 播放时按下标记片段结束点 |
| 片段数据库文件 | 空（使用默认路径）| SQLite 数据库存储路径 |

修改快捷键后保存，刷新 Emby Web 页面生效。

## 使用指南

### 截取片段

1. 在 Emby Web 中播放视频。
2. 按下片段开始快捷键（默认 `[`）标记起始点。
3. 按下片段结束快捷键（默认 `]`）标记结束点。
4. 片段自动保存，可在详情页编辑。

### 编辑片段

1. 进入视频详情页，在播放按钮下方找到「编辑片段」按钮。
2. 点击进入片段编辑弹窗。
3. 可以新增、修改名称、调整时间、删除片段。
4. 时间格式支持：`秒`（如 `83.250`）或 `HH:MM:SS.mmm`（如 `0:01:23.250`）。

### 循环播放

- **详情页**：点击片段按钮 → 自动播放并循环该片段。
- **播放界面**：进度条下方显示所有片段，点击循环，再次点击取消。

### 取消循环

- 再次点击当前循环的片段按钮。
- 或者点击 Emby 原生播放/继续播放按钮，自动清除循环。

## 版本历史

### v1.1.18.1
- 删除 200ms 循环 seek 轮询，阻止 seek 重入和媒体卸载后续播。
- 不再使用会落到附近关键帧的 `fastSeek`。
- Linux UI 从 Emby 4.9.5.0 原版 DEB 生成，仓库同时保存原版和注入版。

### v1.1.1
- 片段排序改为自然序号
- 增强播放页 itemId 识别（直接播放也能显示片段按钮）
- 播放界面片段按钮改为增量更新 + 事件委托，解决多次点击问题
- 退出播放后清理循环状态
- 插件设置页改为 Emby 原生风格
- 后端 SQLite 存储支持

### v1.0.0
- 初始版本：快捷键截取、编辑、循环播放

## 许可证

MIT

## 贡献

欢迎提交 Issue 和 Pull Request。

## 注意事项

- Emby 升级会覆盖 dashboard 文件；每个 Emby 版本都应从对应的原版安装包重新生成注入版。
- DLL 和 dashboard 文件必须作为同一版本一起更新。
- 如果播放界面没有显示片段按钮，尝试 `Ctrl+F5` 强制刷新浏览器缓存。

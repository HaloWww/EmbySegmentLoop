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
├── EntryPoint.cs             # 启动入口：数据库初始化及 Windows 前端注入
├── ConfigurationPage.cs      # 插件设置页 HTML
├── SegmentRepository.cs      # SQLite 数据库操作 (P/Invoke)
├── SegmentLoopService.cs     # REST API：片段的 GET/POST
├── segmentloop.js            # 前端脚本（嵌入 DLL 资源）
├── build_linux_dashboard.py  # 从官方 DEB 生成原版/注入版 Linux UI
├── linux-dashboard/          # Linux 原版文件、注入文件及 SHA-256 清单
├── build-release.ps1         # 构建+打包脚本
├── .gitignore
└── README.md
```

## 环境要求

| 依赖 | 说明 |
|------|------|
| Emby Server | 4.9.x |
| .NET SDK | 8.0 |
| Windows / Linux | .NET 8；Linux 前端文件对应 Emby 4.9.5.0 DEB |

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
构建前会强制从 `T:\emby-server-deb_4.9.5.0_amd64.deb` 重新提取原版
Linux dashboard 文件并生成注入版，避免在已经修改过的文件上重复注入。

构建产物：
- `release\Emby.Plugins.SegmentLoop.dll` — 插件 DLL
- `release\dashboard-ui` — 可直接覆盖的 Linux dashboard 文件
- `Emby.Plugins.SegmentLoop-{version}.zip` — 发布包

## 安装

### Linux（Emby 4.9.5.0）

运行：

```bash
sudo bash install-debian.sh
```

安装脚本下载 DLL、清单和已经生成好的注入文件，校验文件大小及 SHA-256
后直接覆盖：

- `/opt/emby-server/system/dashboard-ui/index.html`
- `/opt/emby-server/system/dashboard-ui/item/item.js`
- `/var/lib/emby/plugins/Emby.Plugins.SegmentLoop.dll`

NAS 上不再使用 `sed` 或临时 Python 修改 Emby 压缩文件。

### Windows / ZIP 发布包

1. 解压 ZIP，将 `Emby.Plugins.SegmentLoop.dll` 复制到 Emby Server 的 `programdata\plugins` 目录。
2. 重启 Emby Server。

### Windows 开发者直接安装

```powershell
Copy-Item .\release\Emby.Plugins.SegmentLoop.dll -Destination "<Emby目录>\programdata\plugins" -Force
```

然后重启 Emby Server。

## 工作原理

### 插件启动

`EntryPoint.Run()` 始终初始化 SQLite 数据库。Windows 保留 `c4ca5aa`
原有的 DLL 启动注入方式；Linux 不在 Emby 启动时修改系统文件，改由安装包
直接覆盖从官方 DEB 生成并校验过的文件。

### 前端注入

- `linux-dashboard/4.9.5.0/original`：从官方 DEB 逐字节提取的原文件。
- `linux-dashboard/4.9.5.0/injected`：只在对应原文件中加入插件脚本和详情页刷新 hook。
- `manifest.json`：记录 DEB、原文件和注入文件的大小及 SHA-256。
- Linux 前端通过插件配置 API 读取快捷键，保存设置后刷新 Web 页面即可生效。

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
- 播放、编辑、存储逻辑回退并保持为 `c4ca5aa` 版本。
- Linux 注入文件从 Emby 4.9.5.0 官方 DEB 生成。
- 仓库同时保存原版文件、注入版文件和 SHA-256 清单。
- Linux 安装改为校验后直接覆盖，不再现场修改 Emby 文件。

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

- Linux 上 DLL 与 `dashboard-ui` 覆盖文件必须作为同一版本一起安装。
- Emby 升级会覆盖 dashboard 文件；新版本必须从对应官方安装包重新生成注入版。
- 仓库中的 `original` 文件可用于核对或恢复 Emby 4.9.5.0 原始 dashboard。
- 如果播放界面没有显示片段按钮，尝试 `Ctrl+F5` 强制刷新浏览器缓存。

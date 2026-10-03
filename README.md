# Emby Segment Loop

视频片段截取与循环播放插件，适用于 Emby Server 4.9.x。

## 功能概述

- **快捷键截取片段**：播放中按开始/结束快捷键截取视频片段，默认 `[` 开始、`]` 结束。
- **片段编辑**：在视频详情页修改片段名称、开始时间、结束时间（精确到毫秒）。
- **循环播放**：点击详情页或播放界面进度条下方的片段按钮，直接跳转并循环播放该片段，再次点击取消。
- **BIF 悬停预览**：鼠标悬停片段按钮时显示时间范围，并在小窗中快速播放片段范围内的 Emby BIF 预览帧。
- **服务端存储**：片段数据持久化到 SQLite 数据库，支持自定义存储路径。
- **插件设置页**：在 Emby 插件设置中配置快捷键。
- **视频详情预览信息**：在播放按钮附近显示所选视频版本的文件大小、容器和分辨率，悬停显示精确字节数。大小采用 KiB/MiB/GiB；远程源或未提供大小时显示“未知”。
- **影片卡片高亮**：设置页可选择关闭、仅收藏、仅有片段或两者都高亮。收藏为金色、有片段为青色，同时满足显示双色边框；收藏状态按当前登录用户判断。

## 项目结构

```
EmbySegmentLoop/
├── EmbySegmentLoop.csproj    # 项目文件 (.NET 8)
├── Plugin.cs                 # 插件主类 + 配置模型
├── EntryPoint.cs             # 启动入口：数据库初始化及 Windows 前端注入
├── ConfigurationPage.cs      # 插件设置页 HTML
├── SegmentRepository.cs      # SQLite 数据库操作 (P/Invoke)
├── SegmentLoopService.cs     # REST API：片段的 GET/POST
├── SegmentCleanupTask.cs     # 删除事件监听配套的定时孤立记录清理
├── segmentloop.js            # 前端脚本（嵌入 DLL 资源）
├── build_linux_dashboard.py  # 从官方 DEB 生成原版/注入版 Linux UI
├── remux_bad_mp4s.py         # Linux 视频容器检查与安全重封装工具
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
也可传入 `-p:EmbySystemPath="Emby system 目录"`，无需修改项目文件。

### 3. 构建

```powershell
# 方式一：使用构建脚本（生成 ZIP 发布包）
.\build-release.ps1

# 方式二：直接 dotnet publish
dotnet publish -c Release -o .\publish
```

`build-release.ps1` 会自动检测 `T:\dotnet-sdk-8.0.422-win-x64\dotnet.exe`，找不到时回退到系统 PATH 中的 `dotnet`。
构建时优先从 `T:\emby-server-deb_4.9.5.0_amd64.deb` 提取原版 Linux dashboard。
DEB 不存在时，会先校验仓库 `original` 文件的大小与 SHA-256，再重新生成注入版。
可用 `-EmbySystemPath` 和 `-DebPath` 参数指定其他路径。编译失败会停止打包。

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
  - `GET /SegmentLoop/State/{ItemId}` — 获取片段与 Revision；保存时传入 ExpectedRevision，可防止旧页面覆盖其他页面的新修改（冲突返回409）
  - `GET /SegmentLoop/ClientConfiguration` — 为登录用户提供快捷键配置，不暴露数据库路径

片段是视频级共享数据；能够访问视频的登录用户可以编辑片段。保存失败的浏览器副本
可通过编辑窗口中的“恢复本浏览器未保存的修改”恢复。视频信息扩展适用于 Emby Web 详情页；
原生手机、电视客户端不会运行 Web 注入脚本。

## 插件设置

在 Emby 管理控制台 → 插件 → Segment Loop 中配置：

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| 片段开始快捷键 | `[` | 播放时按下标记片段起始点 |
| 片段结束快捷键 | `]` | 播放时按下标记片段结束点 |
| 片段数据库文件 | 空（使用默认路径）| SQLite 数据库存储路径 |
| 无效片段清理间隔 | `24` 小时 | 定期清理媒体库中已不存在的 ItemId；设为0关闭定时清理 |
| 影片卡片高亮边框 | 收藏或有片段的影片 | 支持关闭、仅收藏、仅有片段、两者都高亮；保存后当前页面立即生效，其他已打开页面刷新后生效 |

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

## 视频容器检查与修复工具

仓库根目录的 `remux_bad_mp4s.py` 用于检查可能造成 Emby 直接播放反复读取、
播放卡死或 BIF 预览缩略图时间错误的视频容器。此工具仅面向 Linux/NAS，
需要 Python 3.9+、FFmpeg、FFprobe、GNU `stat`/`sync`，默认路径分别为：

```text
/usr/bin/ffmpeg
/usr/bin/ffprobe
/dev/shm
/var/lib/segmentloop-remux/scan-cache.sqlite3
```

### 下载到 NAS

```bash
curl -fL \
  https://raw.githubusercontent.com/HaloWww/EmbySegmentLoop/main/remux_bad_mp4s.py \
  -o /home/wangzhendong/remux_bad_mp4s.py
chmod +x /home/wangzhendong/remux_bad_mp4s.py
```

### 只检查，不修改

```bash
python3 /home/wangzhendong/remux_bad_mp4s.py \
  "/vol00/HSH721414ALN6M0/NSFW" --dry-run
```

### 检查并修复

替换原视频需要 root 权限。脚本优先把完整临时输出写入 `/dev/shm`，校验通过并
确认写入完成后才替换源文件：

```bash
sudo python3 /home/wangzhendong/remux_bad_mp4s.py \
  "/vol00/HSH721414ALN6M0/NSFW"
```

脚本默认只修复已确认的音视频包间距异常，以及会导致 Emby 4.9.5 BIF 时间错误的
QuickTime `qt` + 尾置 `moov` 组合。要同时修复普通 MP4 的单纯 `moov` 尾置：

```bash
sudo python3 /home/wangzhendong/remux_bad_mp4s.py \
  "/vol00/HSH721414ALN6M0/NSFW" --fix-moov-only
```

### 内存不足时使用磁盘临时目录

```bash
sudo python3 /home/wangzhendong/remux_bad_mp4s.py \
  "/vol00/HSH721414ALN6M0/NSFW" \
  --fallback-temp-dir "/vol00/segmentloop-remux-temp"
```

只有 `/dev/shm` 剩余空间小于“源文件大小 + 256 MiB”时才使用备用目录。脚本持有
独占锁并严格逐个处理文件；上一个文件完成校验、替换、`fsync` 和 `sync -f`
之后才会开始下一个文件，避免叠瓦盘多文件并发写入。

### 扫描缓存、失败记录和重新检查

正常文件和已成功替换的文件会按路径、大小、修改时间、设备及 inode 记录到
SQLite，下次运行时不会再次读取完整媒体内容。

查看指定目录下的失败文件和完整原因：

```bash
python3 /home/wangzhendong/remux_bad_mp4s.py \
  "/vol00/HSH721414ALN6M0/NSFW" --list-failures
```

重新处理文件内容未变化的历史失败项：

```bash
sudo python3 /home/wangzhendong/remux_bad_mp4s.py \
  "/vol00/HSH721414ALN6M0/NSFW" --retry-failed
```

忽略全部缓存，对指定目录执行全局重新检查：

```bash
sudo python3 /home/wangzhendong/remux_bad_mp4s.py \
  "/vol00/HSH721414ALN6M0/NSFW" --recheck-all
```

可以用 `--state-file /自定义路径/scan-cache.sqlite3` 修改记录库位置。若只希望
全局复查而不修改文件，可以组合使用 `--recheck-all --dry-run`。

### 重封装与安全策略

- 首先使用 `-map 0 -c copy` 复制全部媒体流，不转码视频。
- MP4 因 `pcm_f32le` 等源音频编码不受容器支持而失败时，才保持视频及其他流
  复制，仅把音频转换为 AAC 320 kbps。
- 临时输出必须通过时长、流数量、流类型、视频编码、`moov` 位置及 BIF 兼容性
  校验，之后才允许替换原文件。
- 临时重封装失败时原视频不变并继续下一个文件；原视频替换阶段失败时尝试回滚，
  然后立即停止整个批处理，避免继续产生磁盘写入。
- 退出码 `0` 表示全部成功，`1` 表示存在检查或临时重封装失败，`2` 表示原视频
  替换/写入阶段失败并已停止后续处理。

查看所有参数：

```bash
python3 /home/wangzhendong/remux_bad_mp4s.py --help
```

## 版本历史

### v1.1.23.0

- 修复封面图片遮住高亮边框和页面样式覆盖双色边框的问题，改为封面上方的边框图层，不改变卡片尺寸。
- 滚动加载、复用卡片和收藏状态更新后，在下一帧刷新边框，减少漏显示和延迟。

### v1.1.22.0
- 增加“影片卡片高亮边框”设置，覆盖首页、媒体库、搜索、收藏页等使用 Emby 卡片组件的影片卡片。
- 按当前用户的实时收藏状态显示金色边框，按服务端已保存片段显示青色边框；同时满足显示双色边框。
- 已认证批量接口每次最多查询100个视频，遵守用户的媒体库可见权限；浏览器缓存结果30秒，片段保存后立即失效。
- 关闭或切换高亮模式立即清除不适用的边框，不高亮媒体库文件夹和演职人员卡片。

### v1.1.21.0
- 视频详情页增加文件大小、容器与分辨率；按所选媒体版本更新，合并重复请求并限制缓存数量。
- 修复自定义数据库路径重启后丢失、非法片段范围缺少服务端校验和 SQLite 失败路径资源泄漏。
- 保存前等待已有片段读取完成，同一页面的保存按顺序执行；新客户端使用 Revision 检测跨页面保存冲突。
- 修复旧视频循环状态和截取起点串到新视频、暂停被强制继续、转码时间轴偏移以及非法时间输入。
- 普通用户可以读取快捷键；片段接口检查视频存在性与用户的媒体库可见权限。
- 重封装工具在备份后目录同步失败时恢复原文件，并拒绝替换处理期间发生变化的源文件。
- 发布包清单增加 DLL 校验，构建失败不再继续复制旧产物。

## 回归检查

```powershell
node --test tests/frontend.test.cjs tests/config.test.cjs
dotnet run --project tests/RepositoryChecks -c Release -p:EmbySystemPath="Emby system 目录"
python -m unittest discover -s tests -p 'test_*.py'
```

SQLite 检查在临时目录创建测试库；重封装检查使用临时文件和故障模拟，不处理真实视频。
整体检视与验证范围见 [CODE_REVIEW.md](CODE_REVIEW.md)。

### v1.1.20.0
- 详情页和播放页的片段按钮增加悬停预览小窗，同时显示片段名称与毫秒级时间范围。
- 复用 Emby `ThumbnailSet`/BIF 接口播放片段范围内的预览帧，不读取原视频。
- BIF 索引限制为16个视频的内存缓存，预览帧只播放一遍；无 BIF 或请求失败时静默降级为范围提示。

### v1.1.19.0
- 监听 Emby `ItemRemoved` 事件，视频删除时立即按数字 ItemId/GUID 清理片段。
- 增加“清理无效视频片段”计划任务，定期删除媒体库中已不存在的孤立记录。
- 插件设置页可配置清理间隔，默认24小时，设为0关闭自动定时清理。

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

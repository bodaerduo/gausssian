# 视频重建 Gaussian Splatting：Gaussian Studio 与知乎开源方案对比

> 调研日期：2026-09-01  
> 适用对象：希望用手机/相机视频重建静态物体或场景，并获得可查看、可编辑、可交付的 3D Gaussian Splatting（3DGS）模型的个人或小团队。  
> 版本提示：软件版本、预编译包分发方式和商业价格会变化；部署前请复核上游页面。

## 1. 结论先行

1. **Gaussian Studio 确实支持视频重建 Gaussian**：README 明确支持单个 MP4/MOV/WebM/M4V，流程是 FFprobe/FFmpeg 抽帧 → COLMAP 相机与稀疏点 → Brush GPU 训练 → 标准 3DGS PLY。
2. **Gaussian Studio 不能确认是“许可证意义上的开源”**：仓库公开且 README 未写收费，但当前仓库文件列表和浅克隆均未发现 `LICENSE`/`NOTICE`，也未见许可证声明。可把它当作可试用的公开代码项目，不要在未获得作者授权前直接商业再分发或闭源集成。
3. **知乎教程的免费路线是可行的**：FFmpeg（抽帧）+ COLMAP（相机位姿/稀疏点）+ Brush 或 LichtFeld Studio（Gaussian 训练/导出）。它比 Postshot 更开放，但需要手动安装、组织目录和排查失败原因。
4. **推荐分层**：
   - 只想尽快验证效果、Windows + NVIDIA：先用 Gaussian Studio。
   - 需要可审计许可证、可脚本化和长期维护：采用 FFmpeg + COLMAP + Brush 为主线，LichtFeld 作为人工检查/编辑工具；把 Gaussian Studio 作为可选的本地 Demo，而不是生产核心依赖。
   - 动态人体、多人运动或相机快速穿行：不要把普通 3DGS 视频流程当作 4D 重建，需要动态/时序方案或额外深度与跟踪模型。

## 2. 许可证与开源性

| 组件 | 上游证据 | 许可证/费用判断 | 对项目的含义 |
|---|---|---|---|
| Gaussian Studio | [GitHub 仓库与 README](https://github.com/869413421/gaussian-studio) | 未发现 LICENSE/NOTICE，README 未声明许可证；不能确认 OSI 开源或商业再分发权 | 可下载和研究试用；商业集成、二次分发前应取得作者书面许可，并审计随附引擎 |
| Brush | [ArthurBrussee/brush](https://github.com/ArthurBrussee/brush) | Apache License 2.0；仓库说明支持 COLMAP 数据、训练和 PLY 查看 | 适合作为可脚本化训练主线；保留许可证和 NOTICE/归属信息 |
| COLMAP | [colmap/colmap](https://github.com/colmap/colmap) | COLMAP 本体 New BSD；第三方依赖另有许可证 | 可用于商业项目，但需保留 BSD 文本并审计打包依赖 |
| FFmpeg | [官方法律说明](https://ffmpeg.org/legal.html) | 默认 LGPL 2.1+；启用 GPL 部件时整体受 GPL 约束 | 分发二进制时确认构建选项、动态链接和源码/许可证提供方式 |
| LichtFeld Studio | [官方 README](https://github.com/MrNeRF/LichtFeld-Studio) | GPLv3；源码构建免费。Windows 预编译包目前通过 Portal 的付费捐赠获取 | 源码路线开放但合规要求更强；预编译包不能再称为“完全免费获取” |
| Jawset Postshot（教程演示） | [知乎原文](https://zhuanlan.zhihu.com/p/2021989571714459402) | 文章称免费版功能不受限但不能导出通用 `.ply`；文中价格仅是当时描述 | 可用于体验，不适合作为“免费可交付 PLY”的方案；当前价格需另查官网 |

**重要边界**：软件许可证只约束软件代码/二进制，不自动授予输入视频、拍摄人物、场景纹理或生成模型的版权、肖像权和隐私许可。

## 3. 两条工作流

### 3.1 Gaussian Studio：集成式 Windows 视频流水线

官方 README 给出的生产链路：

```text
单个 MP4/MOV/WebM/M4V
  → FFprobe 读取视频信息
  → FFmpeg 按质量档位连续抽帧
  → COLMAP（共享相机内参、顺序匹配、Bundle Adjustment）
  → 注册率与三维点质量验证
  → Brush GPU 训练
  → PLY 属性校验与发布
```

关键特性：

- 当前 API 的质量档位：快速/推荐/高质量分别为 854×480 / 1280×720 / 1920×1080 输入、2/4/6 FPS、10k/30k/50k Brush iterations；Brush 最大训练分辨率为 480/720/1080，最大 Splat 数量为 2M/5M/8M。
- COLMAP 默认 `SIMPLE_RADIAL`、`single_camera=1`、顺序匹配窗口 20；快速移动或遮挡多时可提高 `GS_COLMAP_OVERLAP`。
- 注册率低于 50% 直接失败；50%–80% 为警告；至少 80% 才算正常。发布前检查位置、颜色、透明度、尺度、旋转等 Gaussian 属性。
- 浏览器负责上传、进度、历史和查看，后端通过 Node.js/TypeScript/Vite/SSE 调度本地原生引擎；可通过 `GS_ENGINE_DIR`、`GS_FFMPEG`、`GS_COLMAP`、`GS_BRUSH` 覆盖路径。

### 3.2 知乎教程：可替换的免费开源组件链

知乎文章先用 Postshot 演示，再拆成三个可替换步骤：

```text
视频 → FFmpeg 抽帧 → COLMAP 自动重建（相机+稀疏点）
     → Brush 或 LichtFeld Studio 训练 → 导出 PLY → 查看/编辑
```

教程提取的操作要点：

1. **抽帧**：FFmpeg 默认示例为每秒 1 帧、JPG；1 分钟视频约 60 张。帧率越高，COLMAP 和训练越慢，近重复帧还可能降低匹配效率。
2. **COLMAP**：工作目录下建立 `images/`，选择 Automatic reconstruction；视频抽帧选择 `video frames`，可用 CUDA 版或 CPU 版；教程建议不勾选 Dense model，以节省时间和磁盘。
3. **数据结构**：

   ```text
   output/
   ├── images/
   ├── sparse/0/
   │   ├── cameras.bin
   │   ├── images.bin
   │   └── points3D.bin
   └── database.db
   ```

4. **Brush**：打开工作目录，训练步数示例为 30k，分辨率约 1920（1080p）；可调最大 splat 数量，训练中可实时查看并导出 PLY。
5. **LichtFeld Studio**：中文界面、参数提示和编辑功能较多；广角/鱼眼或畸变数据可尝试启用 GUT。当前官方要求 NVIDIA compute capability 7.5+、驱动 570+、CUDA 12.8+；源码构建免费，Windows 预编译包从 Portal 获取需付费捐赠。
6. **拍摄约束**：多角度、清晰、光照一致；教程建议相邻图像重叠大于 60%。

## 4. 功能与工程对比

| 维度 | Gaussian Studio | 知乎免费组件链（FFmpeg+COLMAP+Brush/LichtFeld） |
|---|---|---|
| 视频输入 | 原生单视频上传，自动抽帧 | 先手动/脚本抽帧，再导入图像目录 |
| 端到端自动化 | 高：任务、进度、历史、质量门槛已封装 | 中：每个组件成熟，但需手动串联；可自行脚本化 |
| PLY 交付 | README 明确发布标准 3DGS PLY | Brush/LichtFeld 可导出 PLY；Postshot 免费版不可导出通用 PLY |
| 开源与许可证 | 代码公开但未声明许可证，法律边界不清 | 组件许可证清晰（Apache/BSD/LGPL 或 GPLv3），但需分别履约 |
| 平台 | Windows 10/11 x64 | Brush/FFmpeg/COLMAP 可跨平台；LichtFeld 以 NVIDIA Windows/Linux 为主 |
| GPU | Gaussian Studio README 要求 NVIDIA GPU/兼容驱动 | COLMAP 可 CPU；Brush 支持多种后端；LichtFeld 需 NVIDIA 7.5+ |
| 安装复杂度 | `make setup` 下载固定引擎，约需 30 GB 磁盘 | 需分别下载、配置 PATH、目录和版本，排障成本更高 |
| 可控性 | 质量档位和环境变量有限但简单 | 可独立替换抽帧、匹配器、训练器、查看器和参数 |
| 编辑能力 | 重点是重建和查看，编辑能力有限 | LichtFeld 可选择/变换/编辑 Gaussian；Brush 更偏训练和查看 |
| 适合场景 | Windows 工作站、快速 Demo、批量单视频 | 研究、生产流水线、许可证审计、跨平台/脚本化 |
| 主要风险 | 无许可证声明；固定引擎归档和 NVIDIA 绑定 | 组件组合复杂；GPL/LGPL 合规、版本兼容和人工操作风险 |

## 5. 面向“视频重建 Gaussian”的推荐架构

### 推荐主线：可审计的模块化架构

```text
采集规范/素材登记
        ↓
FFmpeg/FFprobe（抽帧、分辨率、帧率、哈希）
        ↓
COLMAP CUDA（顺序匹配、相机位姿、稀疏点、注册率）
        ↓
Brush（主训练器，Apache-2.0）
        ↓
PLY 属性/数量/异常尺度校验
        ↓
LichtFeld（可选人工清理、裁剪、编辑）
        ↓
Three.js/gaussian-splats-3d、Brush 或其他查看器发布
```

选择理由：训练器与查看器可替换；COLMAP 结果可复用；每一步都有中间产物和质量指标；许可证边界比 Gaussian Studio 清晰。若团队只在 Windows + NVIDIA 内部使用，可把 Gaussian Studio 放在同一架构旁路，作为快速验收入口。

### 不推荐直接采用的情况

- 需要把 Gaussian Studio 代码或其固定引擎打包进商业产品，但无法获得作者许可证说明。
- 输入是单目动态人物、多人运动、车辆高速运动或场景本身变化；普通 COLMAP + 静态 3DGS 会产生重影、漂浮物和时序不一致。
- 目标是可用于碰撞、测量或制造的精确网格；3DGS 更适合新视角渲染，几何精度需额外摄影测量/网格流程验证。

## 6. 环境要求

### Gaussian Studio 路线

- Windows 10/11 x64。
- Node.js 20+、GNU Make。
- NVIDIA GPU 与兼容驱动；README 未给出最低显存，按视频分辨率、帧数和 splat 数量预留余量。
- 建议至少 30 GB 可用磁盘；固定版本 FFmpeg、COLMAP CUDA、Brush 会下载到 `engines/`。

### 模块化路线

- FFmpeg/FFprobe：用于视频信息读取和抽帧；若分发软件，确认 LGPL/GPL 构建选项。
- COLMAP：Windows/Linux/macOS 均可；NVIDIA 使用 CUDA 版，不能用 CUDA 时走 CPU 版（速度较慢）。
- Brush：可使用发布的原生二进制或从源码构建；许可证 Apache-2.0。
- LichtFeld（可选）：NVIDIA compute capability 7.5+（GTX 16、RTX 20 及更新型号）、驱动 570+、CUDA 12.8+；AMD/Intel 和 GTX 10 系列不在当前支持范围。
- 存储：原视频、抽帧、COLMAP 数据库/稀疏点、检查点和 PLY 可能同时存在；短视频也建议预留 30 GB 级别空间。

## 7. 实施步骤

### 阶段 A：先做可行性样片（1 个短视频）

1. 采集 20–60 秒静态主体视频：相机缓慢环绕，主体占画面约 60%–80%，锁定曝光/焦距/白平衡，避免快速运动、反光和透明材质。
2. 使用 Gaussian Studio 的 `balanced` 档跑通端到端，或用 FFmpeg 每秒约 1–2 帧抽取 100–300 张关键帧。
3. 检查 COLMAP 注册率、相机轨迹是否闭合、稀疏点是否覆盖主体；注册率不足时先补拍/调整抽帧，不要盲目增加训练步数。
4. 用 Brush 训练约 15k–30k 步，先以 1080p/中等 splat 数量验收，再提高分辨率和点数。
5. 导出 PLY，在至少两个查看器中检查：孔洞、拉丝、漂浮点、背面缺失、颜色闪烁和坐标方向。

### 阶段 B：固化为可复现流水线

1. 固定工具版本、GPU 驱动、抽帧 FPS、图像质量和 COLMAP 参数；记录 SHA-256 与许可证文件。
2. 为每个任务保存：原视频哈希、抽帧清单、COLMAP 日志、注册率、三维点数、训练参数、PLY 大小和预览图。
3. 将抽帧、COLMAP、训练、PLY 校验封装为脚本/任务队列；失败任务保留中间产物，支持从失败阶段恢复。
4. 将 Gaussian Studio 仅作为 Windows 本地体验入口；生产任务走模块化主线，避免被未声明许可证或固定引擎版本锁定。

### 阶段 C：质量与发布

1. 设质量门槛：注册率 ≥80%；PLY 必须有位置、颜色、不透明度、尺度、旋转；异常大尺度和近透明 Gaussian 做过滤。
2. 对反光/透明/弱纹理主体增加漫反射纹理、偏振或多视角补拍；必要时加入遮罩。
3. 发布前清理隐私和版权风险，确认人物肖像、室内物品、音乐和第三方素材的使用权。
4. 交付 PLY 时同时交付许可证清单、生成参数、查看器版本和已知缺陷说明。

## 8. 风险与注意事项

- **静态假设**：普通 3DGS 将所有帧视为同一静态场景；人走动、树叶摆动、转台背景变化会形成鬼影或重复结构。
- **相机与匹配**：视频帧过密会增加近重复匹配；帧过稀或重叠不足会导致注册率下降。教程的“重叠 >60%”是实用经验，不是硬性保证。
- **材质难点**：透明、镜面、黑色弱纹理、头发和细线结构通常需要更多视角、遮罩或专门算法。
- **GPU/版本**：CUDA、驱动、PyTorch（若引入其他训练器）和显卡架构必须成套验证；LichtFeld 的要求明显高于仅使用 CPU COLMAP 的方案。
- **许可证合规**：Gaussian Studio 未声明许可证；Brush、COLMAP、FFmpeg、LichtFeld 的许可证不能互相替代。尤其注意 FFmpeg 的 GPL 可选组件和 LichtFeld 的 GPLv3 传播义务。
- **供应链**：Gaussian Studio 的 `make setup` 会下载固定引擎归档；生产环境应校验 SHA-256、保存来源和版本，避免上游文件变更导致不可复现。
- **结果用途**：PLY 是外观优先的显式表示，不等同于带拓扑、尺度可靠的 CAD/测量网格；严肃测量应增加标定和独立精度验证。

## 9. 最终建议

**个人/小团队试用**：Windows + NVIDIA 时，先用 Gaussian Studio `balanced` 跑一个短视频；它最省安装时间，能快速确认拍摄质量和显卡是否够用。

**需要长期维护或商业交付**：采用 `FFmpeg/FFprobe + COLMAP + Brush` 主线，LichtFeld 仅作可选编辑器；建立许可证清单、固定版本和质量门槛。这样可以保留视频输入能力，又不把核心业务绑定到一个未声明许可证的仓库。

**动态视频项目**：将需求升级为“动态/4D Gaussian 或带深度与跟踪的时序重建”专项评估，不要仅通过提高普通 3DGS 的迭代次数解决。

## 参考链接

- [Gaussian Studio（仓库与 README）](https://github.com/869413421/gaussian-studio)
- [知乎：免费开源，使用3D高斯泼溅进行三维建模](https://zhuanlan.zhihu.com/p/2021989571714459402)
- [Brush](https://github.com/ArthurBrussee/brush)
- [LichtFeld Studio](https://github.com/MrNeRF/LichtFeld-Studio)
- [COLMAP](https://github.com/colmap/colmap)
- [FFmpeg License and Legal Considerations](https://ffmpeg.org/legal.html)

# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在此代码仓库中工作时提供指引。

## 项目概述

**安居集团工程视频分析系统** — 面向安居集团工程管理人员的内部 AI 工具。工程师上传施工现场视频，系统通过 AI 自动生成分析报告，涵盖安全隐患、人员数量、材料使用、机械设备及施工进度。

**当前状态：** v1.1 开发中（基于 `v1.1` 分支），`main` 分支为已发布的 v1.0。主要文件：
- `安居集团工程视频分析系统PRD.md` — 产品需求文档（含 v1.1/v2.0 迭代规划）
- `src/App.jsx` — 主应用组件（React + Tailwind CSS，单文件约 1600 行）
- `src/main.jsx` — React 入口
- `Dockerfile` / `docker-compose.yml` — 容器化部署
- `SETUP.md` — OSS CORS 管理员配置指南

## 本地启动

```bash
# 1. 填写环境变量
cp .env.example .env
# 编辑 .env，填入 OSS 和 Qwen API 密钥

# 2. 构建并启动（首次约 2 分钟）
docker compose up --build -d

# 3. 访问
open http://localhost:8081

# 修改密钥后无需重新构建，只需重启
docker compose restart
```

## 实现方案

**Vite + React + Tailwind CSS**，通过 Docker 多阶段构建（Node 编译 → Nginx 运行）独立部署，无传统后端服务器。核心流程：
- 通过 OSS Signature V1 预签名 URL 直传视频至**阿里云 OSS**（XHR 上传，带进度）
- 调用 **Qwen3-VL-Plus**（通义千问视觉语言大模型）进行 AI 分析
- 通过 SSE 流式接收并实时渲染分析结果

## 架构

```
用户浏览器
    ↓
Nginx（Docker，端口 8081）
    ↓
React SPA（Vite 构建，Tailwind CSS）
    ├─→ 阿里云 OSS   （视频 + 分析结果存储，Signature V1 预签名 URL）
    └─→ Qwen3-VL-Plus API   （视频 URL + 提示词 → SSE 流式分析结果）
```

### OSS 存储结构（v1.1）

```
anjū-engineering-bucket/
├── videos/{YYYY-MM-DD}/{timestamp}_{filename}.{ext}   ← 视频文件
└── analysis/
    ├── index.json                                      ← 分析记录索引（string[]）
    └── {entry.id}.json                                 ← 单条分析记录
```

**index.json** 是 analysis/ 目录的索引清单（OSS 不支持浏览器直接 ListObjects），每次新增/删除分析记录时同步更新。删除操作目前只更新 index.json，不物理删除 OSS 文件（避免配置 CORS DELETE 权限）。

## 系统配置项

通过项目根目录的 `.env` 文件配置（参考 `.env.example`），Docker 启动时注入为 `window._ENV_`：

```
OSS_REGION=oss-cn-shenzhen       # OSS 地域（格式：oss-cn-xxx，非完整 URL）
OSS_BUCKET=                       # Bucket 名称
OSS_ACCESS_KEY_ID=                # 阿里云 AccessKey ID（建议 RAM 子账号）
OSS_ACCESS_KEY_SECRET=            # 阿里云 AccessKey Secret
QWEN_API_KEY=                     # 通义千问 / DashScope API Key
```

`.env` 已加入 `.gitignore`，不会提交到 git。应用内也保留配置面板（⚙️），可在运行时手动覆盖。

## 核心模块（v1.1）

| 模块 | 关键说明 |
|------|---------|
| **视频上传（F1）** | 支持 MP4/MOV/AVI，最大 200MB，拖拽上传，XHR 直传 OSS |
| **视频播放（F2）** | HTML5 `<video>`，16:9，变速 0.5×–2×，签名 URL 自动续签 |
| **提示词管理（F3）** | 可编辑文本域，500 字上限，默认提示词，快捷标签 |
| **AI 分析（F4）** | Qwen3-VL-Plus，120s 超时，SSE 流式输出，显示耗时 |
| **结果展示（F5）** | Markdown 渲染（支持 h1–h5），复制/导出 .txt，会话历史最多 3 条 Tab |
| **分析持久化（v1.1）** | 分析完成后自动保存 JSON 到 OSS，同步更新 index.json |
| **历史记录抽屉（v1.1）** | 📋 按钮打开，按日期分组，支持恢复（视频+结果）和删除 |
| **多视频队列（v1.1）** | 多选文件逐个上传，队列显示状态/进度/元数据，完成后可切换 |

## 关键实现细节

### OSS 签名
使用浏览器原生 `window.crypto.subtle`（SubtleCrypto HMAC-SHA1）实现 OSS Signature V1，无外部库。签名时 **Content-Type 必须参与计算**（视频上传时浏览器会自动附带，签名需与之匹配）。OSS Region 填 `oss-cn-xxx` 格式，不是完整 URL。

### SSE 流式解析
`useQwenAnalysis` hook 使用 `ReadableStream` 逐行解析 SSE，处理 `data: [DONE]` 结束标记，兼容 `delta.content` 为 string 或 array 两种格式。

### 历史加载时机
页面挂载时（`useEffect([], [])`）从 OSS 加载一次历史。分析完成后立即通过 `OSS_HISTORY_ENTRY_ADDED` action 更新本地 state，无需刷新页面。

### 视频元数据探测
选文件后通过 `probeVideoFile(file)` 创建临时 `<video>` + blob URL，监听 `loadedmetadata` 获取时长和分辨率。`file.lastModified` 是系统修改时间，非拍摄时间。

### trackingDispatch 模式
`handleAnalyze` 中用本地变量 `localBuffer` 追踪完整 streamBuffer，绕过 React 的 stale closure 问题，用于分析完成后构建持久化 entry。

## 界面布局

```
Header：🏗 安居集团 · 工程视频分析系统  [🤖 qwen-vl-plus | 🗄 region]  [📋] [⚙️]
┌──────────────────────┬──────────────────┐
│ 视频播放器（60%）     │ 分析提示词（40%）│
│ 或上传拖拽区          │ 快捷标签         │
│ 队列面板（多视频时）  │ [开始视频分析]   │
└──────────────────────┴──────────────────┘
│ 分析结果（全宽）  Markdown | [复制] [导出 .txt]  │
└──────────────────────────────────────────────────┘
历史记录抽屉（右侧滑出，按日期分组）
```

## 错误码

| 错误码 | 触发条件 | 处理方式 |
|--------|---------|---------|
| E001 | 文件格式不支持 | 重新选择文件 |
| E002 | 文件超过 200MB | 压缩后重新上传 |
| E003 | OSS 上传失败 | 重试（CORS 未配置时显示专属提示） |
| E004 | 视频 URL 过期 | 刷新页面自动续签 |
| E005 | 模型 API 调用失败 | 重新分析按钮 |
| E006 | 分析超时（120s） | 提示上传较短视频重试 |
| E007 | 提示词为空 | 分析按钮置灰禁用 |

## 性能指标

- 视频首帧加载：≤3s
- 分析首字符返回：≤10s
- 分析总耗时：30–90s（视视频时长）
- 浏览器支持：Chrome ≥90、Edge ≥90、Firefox ≥88、Safari ≥14

# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在此代码仓库中工作时提供指引。

## 项目概述

**安居集团工程视频分析系统** — 面向安居集团工程管理人员的内部 AI 工具。工程师上传施工现场视频，系统通过 AI 自动生成分析报告，涵盖安全隐患、人员数量、材料使用、机械设备及施工进度。

**当前状态：** 已完成 v1.0 实现。主要文件：
- `安居集团工程视频分析系统PRD.md` — 产品需求文档
- `src/App.jsx` — 主应用组件（React + Tailwind CSS）
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
- 通过预签名 URL 直传视频至**阿里云 OSS**（XHR 上传，显示进度）
- 调用 **Qwen3-VL-Plus**（通义千问视觉语言大模型）进行 AI 分析
- 通过 SSE 流式接收并实时渲染分析结果

## 架构

```
用户浏览器
    ↓
Nginx（Docker，端口 8081）
    ↓
React SPA（Vite 构建，Tailwind CSS）
    ├─→ 阿里云 OSS   （视频存储，OSS Signature V1 预签名 URL，2 小时有效期）
    └─→ Qwen3-VL-Plus API   （视频 URL + 提示词 → SSE 流式分析结果）
```

OSS 存储结构：
```
anjū-engineering-bucket/
└── videos/{YYYY-MM-DD}/{timestamp}_{filename}.{ext}
```

v1.0 分析结果仅保留在页面会话中（最多 3 条，以 Tab 切换）。v1.1 计划持久化到 OSS。

## 系统配置项

通过项目根目录的 `.env` 文件配置（参考 `.env.example`），Docker 启动时自动注入为 `window._ENV_`：

```
OSS_REGION=oss-cn-shenzhen       # OSS 地域
OSS_BUCKET=                       # Bucket 名称
OSS_ACCESS_KEY_ID=                # 阿里云 AccessKey ID（建议 RAM 子账号）
OSS_ACCESS_KEY_SECRET=            # 阿里云 AccessKey Secret
QWEN_API_KEY=                     # 通义千问 / DashScope API Key
```

`.env` 已加入 `.gitignore`，不会提交到 git。应用内也保留配置面板（⚙️），可在运行时手动覆盖。

## 核心模块

| 模块 | 关键说明 |
|------|---------|
| **视频上传（F1）** | 支持 MP4/MOV/AVI，最大 200MB，拖拽上传，XHR 直传 OSS 并显示进度 |
| **视频播放（F2）** | HTML5 `<video>`，16:9，变速 0.5×–2×，签名 URL 刷新自动续签 |
| **提示词管理（F3）** | 可编辑文本域，500 字上限，默认提示词，快捷标签（安全隐患/人员数量/材料使用/机械设备） |
| **AI 分析（F4）** | Qwen3-VL-Plus，120s 超时，SSE 流式输出，显示耗时 |
| **结果展示（F5）** | Markdown 渲染，复制/导出 .txt，会话内历史最多 3 条 Tab |

## 界面布局

```
Header：🏗 安居集团 · 工程视频分析系统
┌──────────────────────┬──────────────────┐
│ 视频播放器（60%）     │ 分析提示词（40%）│
│ 或上传拖拽区          │ 快捷标签         │
│ （16:9）              │ [开始视频分析]   │
└──────────────────────┴──────────────────┘
│ 分析结果（全宽）                          │
│ Markdown 渲染 | [复制] [导出 .txt]        │
└──────────────────────────────────────────┘
```

## 错误码

| 错误码 | 触发条件 | 处理方式 |
|--------|---------|---------|
| E001 | 文件格式不支持 | 重新选择文件 |
| E002 | 文件超过 200MB | 压缩后重新上传 |
| E003 | OSS 上传失败 | 重试按钮（CORS 未配置时显示专属提示） |
| E004 | 视频 URL 过期 | 刷新页面自动续签 |
| E005 | 模型 API 调用失败 | 重新分析按钮 |
| E006 | 分析超时（120s） | 提示上传较短视频重试 |
| E007 | 提示词为空 | 分析按钮置灰禁用 |

## 性能指标

- 视频首帧加载：≤3s
- 分析首字符返回：≤10s
- 分析总耗时：30–90s（视视频时长）
- 浏览器支持：Chrome ≥90、Edge ≥90、Firefox ≥88、Safari ≥14

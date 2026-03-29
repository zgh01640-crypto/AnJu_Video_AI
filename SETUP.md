# OSS 配置指南（管理员操作）

本文档说明在使用安居集团工程视频分析系统前，需要由管理员完成的阿里云 OSS 一次性配置。

---

## 前置条件

- 已拥有阿里云账号
- 已创建 RAM 子账号并授予 OSS 相关权限（推荐使用 RAM 子账号，不要使用主账号 AK/SK）
- 已创建 Bucket（建议选择与用户地理位置相近的 Region）

---

## 1. 配置 Bucket CORS（必须完成）

系统在浏览器中直接上传视频到 OSS，必须配置跨域规则，否则上传会被浏览器拦截。

### 操作步骤

1. 登录 [阿里云 OSS 控制台](https://oss.console.aliyun.com/)
2. 点击目标 Bucket → 左侧菜单选择 **数据安全** → **跨域设置（CORS）**
3. 点击 **创建规则**，填写如下配置：

| 字段 | 值 |
|------|----|
| 来源（Origins） | `https://claude.ai` |
| 允许 Methods | `GET`, `PUT`, `HEAD` |
| 允许 Headers | `*` |
| 暴露 Headers | `ETag`, `Content-Length` |
| 缓存时间（Max Age） | `3600` |

4. 点击 **确定** 保存规则

> **提示：** 如需在本地开发调试，可额外添加 `http://localhost:*` 为允许来源。

---

## 2. 创建 RAM 子账号并授权（推荐）

建议为本系统专门创建一个权限最小化的 RAM 子账号，避免使用主账号密钥。

### 最小权限 Policy

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "oss:PutObject",
        "oss:GetObject",
        "oss:HeadObject"
      ],
      "Resource": [
        "acs:oss:*:*:<your-bucket-name>/videos/*"
      ]
    }
  ]
}
```

将 `<your-bucket-name>` 替换为实际 Bucket 名称。

---

## 3. Bucket 防盗链（可选但推荐）

如需防止视频链接被滥用，可配置 Referer 白名单：

1. Bucket → **数据安全** → **防盗链**
2. Referer 白名单添加：`https://claude.ai`
3. 允许空 Referer：**否**

---

## 4. 获取系统配置所需信息

在系统配置面板中，需要填写以下 5 个字段：

| 字段 | 获取位置 |
|------|---------|
| OSS 地域 (Region) | Bucket 概览页 → Endpoint，取 `oss-cn-xxx` 部分 |
| OSS Bucket 名称 | Bucket 名称 |
| OSS AccessKey ID | RAM 控制台 → 用户 → 创建 AccessKey |
| OSS AccessKey Secret | 创建 AK 时仅显示一次，请妥善保存 |
| 通义千问 API Key | [DashScope 控制台](https://dashscope.console.aliyun.com/) → API KEY 管理 |

---

## 5. 验证配置是否正确

完成上述配置后，可通过以下方式验证：

1. 打开系统，在配置面板填入所有字段
2. 点击"保存配置"
3. 上传一个小的 MP4 文件（建议 < 10MB 用于测试）
4. 若上传成功且视频可播放，则配置正确

### 常见错误排查

| 错误提示 | 原因 | 解决方案 |
|---------|------|---------|
| "OSS 跨域（CORS）未配置" | CORS 规则未生效 | 检查步骤 1，确认来源填写正确 |
| "OSS HTTP 403" | AK/SK 无权限或 Bucket 不存在 | 检查 RAM 权限策略和 Bucket 名称 |
| "OSS HTTP 404" | Bucket 名称或 Region 填错 | 核对控制台中的 Bucket 信息 |
| 视频无法播放（黑屏） | 签名 URL 已过期 | 刷新页面（系统自动重新签名） |

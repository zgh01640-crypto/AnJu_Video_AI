// ===== SECTION 1: IMPORTS =====
import { useState, useReducer, useRef, useCallback, useEffect } from "react";

// ===== SECTION 2: CONSTANTS =====
const DEFAULT_PROMPT = "请分析工程视频，正在进行哪些专业施工，形象进度如何";
const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;  // 20MB
const ALLOWED_TYPES = ["video/mp4", "video/quicktime", "video/x-msvideo", "image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp"];
const ALLOWED_EXTS = [".mp4", ".mov", ".avi", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"];
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp"]);
const ALLOWED_IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
const ANALYSIS_TIMEOUT_MS = 120000;
const MAX_PROMPT_CHARS = 500;
const QWEN_ENDPOINT =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

function getOssStatusDot(ossStatus) {
  if (ossStatus === "loaded") return { color: "#4ade80", title: "OSS 已连接" };
  if (ossStatus === "error") return { color: "#f87171", title: "OSS 连接失败" };
  return { color: "#94a3b8", title: "OSS 状态未知" };
}

function getQwenStatusDot(qwenConnStatus) {
  if (qwenConnStatus === "ok") return { color: "#4ade80", title: "AI 模型已连接" };
  if (qwenConnStatus === "error") return { color: "#f87171", title: "AI 模型连接失败" };
  if (qwenConnStatus === "checking") return { color: "#facc15", title: "AI 模型连接中…" };
  return { color: "#94a3b8", title: "AI 模型状态未知" };
}

const QUICK_TAGS = [
  { label: "安全隐患", appendText: "，并指出画面中是否存在安全隐患" },
  { label: "人员数量", appendText: "，统计视频中出现的施工人员数量" },
  { label: "材料使用", appendText: "，描述使用的主要建筑材料" },
  { label: "机械设备", appendText: "，列举出现的施工机械与设备" },
];

// ===== SECTION 3: UTILITY FUNCTIONS =====

async function generateOSSPresignedUrl(config, objectKey, method = "PUT", expiresIn = 7200, contentType = "") {
  const { ossRegion, ossBucket, ossAccessKeyId, ossAccessKeySecret } = config;
  const expiresTimestamp = Math.floor(Date.now() / 1000) + expiresIn;
  const stringToSign = `${method}\n\n${contentType}\n${expiresTimestamp}\n/${ossBucket}/${objectKey}`;

  const encoder = new TextEncoder();
  const cryptoKey = await window.crypto.subtle.importKey(
    "raw",
    encoder.encode(ossAccessKeySecret),
    { name: "HMAC", hash: { name: "SHA-1" } },
    false,
    ["sign"]
  );
  const sigBuffer = await window.crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(stringToSign)
  );
  const sigBase64 = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)));
  const sig = encodeURIComponent(sigBase64);
  const endpoint = `https://${ossBucket}.${ossRegion}.aliyuncs.com`;
  return `${endpoint}/${objectKey}?OSSAccessKeyId=${ossAccessKeyId}&Expires=${expiresTimestamp}&Signature=${sig}`;
}

function buildOSSObjectKey(filename, projectId = null) {
  const date = new Date().toISOString().slice(0, 10);
  const ts = Date.now();
  const safeName = filename.replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]/g, "_");
  const prefix = projectId || "unassigned";
  return `videos/${prefix}/${date}/${ts}_${safeName}`;
}

function formatElapsed(ms) {
  if (ms == null) return "";
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ===== OSS PERSISTENCE UTILITIES =====

async function saveAnalysisToOSS(config, entry) {
  const json = JSON.stringify({
    ...entry,
    timestamp: entry.timestamp instanceof Date ? entry.timestamp.toISOString() : entry.timestamp,
  });
  const blob = new Blob([json], { type: "application/json" });
  const prefix = entry.projectId || "unassigned";
  const objectKey = `analysis/${prefix}/${entry.id}.json`;
  const putUrl = await generateOSSPresignedUrl(config, objectKey, "PUT", 3600, "application/json");
  const res = await fetch(putUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: blob,
  });
  if (!res.ok) throw new Error(`OSS PUT failed: ${res.status}`);
  return objectKey;
}

async function updateOSSIndex(config, analysisObjectKey, action = "add", projectId = null) {
  const prefix = projectId || "unassigned";
  const indexKey = `analysis/${prefix}/index.json`;
  let currentKeys = [];
  try {
    const getUrl = await generateOSSPresignedUrl(config, indexKey, "GET", 300);
    const res = await fetch(getUrl);
    if (res.ok) currentKeys = await res.json();
  } catch { /* first write or network error — start empty */ }

  if (action === "add") {
    if (!currentKeys.includes(analysisObjectKey)) currentKeys = [analysisObjectKey, ...currentKeys];
  } else {
    currentKeys = currentKeys.filter(k => k !== analysisObjectKey);
  }

  const blob = new Blob([JSON.stringify(currentKeys)], { type: "application/json" });
  const putUrl = await generateOSSPresignedUrl(config, indexKey, "PUT", 3600, "application/json");
  const res = await fetch(putUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: blob,
  });
  if (!res.ok) throw new Error(`OSS index PUT failed: ${res.status}`);
}

// 加载指定项目（或 unassigned）的历史，projectId=null 表示 unassigned
async function loadOSSHistory(config, projectId = null) {
  const prefix = projectId || "unassigned";
  const indexKey = `analysis/${prefix}/index.json`;
  const getUrl = await generateOSSPresignedUrl(config, indexKey, "GET", 300);
  const indexRes = await fetch(getUrl);
  if (!indexRes.ok) {
    if (indexRes.status === 404) return [];
    throw new Error(`index load failed: ${indexRes.status}`);
  }
  const keys = await indexRes.json();

  const results = await Promise.allSettled(
    keys.map(async (objectKey) => {
      const entryUrl = await generateOSSPresignedUrl(config, objectKey, "GET", 300);
      const res = await fetch(entryUrl);
      if (!res.ok) throw new Error(`entry ${objectKey} HTTP ${res.status}`);
      const data = await res.json();
      return { ...data, timestamp: new Date(data.timestamp), projectId: data.projectId || projectId };
    })
  );
  return results
    .filter(r => r.status === "fulfilled")
    .map(r => r.value);
}

// 加载所有项目 + unassigned + 兼容 v1.1 旧 analysis/index.json
async function loadAllOSSHistory(config, projectsList = []) {
  const projectIds = [null, ...projectsList.map(p => p.id)];

  // 并行加载各项目历史 + 兼容 v1.1 legacy（analysis/index.json 顶层）
  const [projectResults, legacyResult] = await Promise.all([
    Promise.allSettled(projectIds.map(pid => loadOSSHistory(config, pid))),
    // v1.1 兼容：尝试读取顶层 analysis/index.json
    (async () => {
      try {
        const getUrl = await generateOSSPresignedUrl(config, "analysis/index.json", "GET", 300);
        const res = await fetch(getUrl);
        if (!res.ok) return [];
        const keys = await res.json();
        const entryResults = await Promise.allSettled(
          keys.map(async (objectKey) => {
            const entryUrl = await generateOSSPresignedUrl(config, objectKey, "GET", 300);
            const r = await fetch(entryUrl);
            if (!r.ok) return null;
            const data = await r.json();
            return { ...data, timestamp: new Date(data.timestamp), projectId: data.projectId || null };
          })
        );
        return entryResults.filter(r => r.status === "fulfilled" && r.value).map(r => r.value);
      } catch { return []; }
    })(),
  ]);

  const all = [
    ...projectResults.filter(r => r.status === "fulfilled").flatMap(r => r.value),
    ...legacyResult,
  ];

  // 去重（同一 id 可能在 legacy 和项目目录都有）
  const seen = new Set();
  const unique = all.filter(e => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });

  return unique.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

async function deleteOSSHistoryEntry(config, entry) {
  const objectKey = `analysis/${entry.projectId || "unassigned"}/${entry.id}.json`;
  await updateOSSIndex(config, objectKey, "remove", entry.projectId || null);
}

// ===== v3.0: ASSET MANIFEST UTILITIES =====

async function loadAssetManifest(config, projectId) {
  const prefix = projectId || "unassigned";
  const objectKey = `assets/${prefix}/manifest.json`;
  try {
    const getUrl = await generateOSSPresignedUrl(config, objectKey, "GET", 300);
    const res = await fetch(getUrl);
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`manifest load failed: ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.message && err.message.includes("404")) return [];
    return [];
  }
}

async function saveAssetManifest(config, projectId, manifest) {
  const prefix = projectId || "unassigned";
  const objectKey = `assets/${prefix}/manifest.json`;
  const blob = new Blob([JSON.stringify(manifest)], { type: "application/json" });
  const putUrl = await generateOSSPresignedUrl(config, objectKey, "PUT", 3600, "application/json");
  const res = await fetch(putUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: blob,
  });
  if (!res.ok) throw new Error(`manifest PUT failed: ${res.status}`);
}

async function deleteOSSObject(config, objectKey) {
  try {
    const deleteUrl = await generateOSSPresignedUrl(config, objectKey, "DELETE", 300);
    const res = await fetch(deleteUrl, { method: "DELETE" });
    if (res.status === 404) return; // already gone
    if (res.status === 403) throw new Error(`DELETE forbidden (403): ${objectKey}`);
    // other non-2xx: swallow silently
  } catch (err) {
    if (err.message && err.message.includes("403")) throw err;
    // network/CORS errors: swallow
  }
}

async function loadAllProjectManifests(config, projectsList) {
  const projectIds = [null, ...projectsList.map(p => p.id)];
  const results = await Promise.allSettled(
    projectIds.map(pid => loadAssetManifest(config, pid))
  );
  const all = results
    .filter(r => r.status === "fulfilled")
    .flatMap(r => r.value);
  // deduplicate by id
  const seen = new Set();
  const unique = all.filter(a => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
  return unique.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
}

async function patchAssetInManifest(config, projectId, assetId, patch) {
  const manifest = await loadAssetManifest(config, projectId);
  let updated;
  if (patch === null) {
    updated = manifest.filter(a => a.id !== assetId);
  } else {
    updated = manifest.map(a => a.id === assetId ? { ...a, ...patch } : a);
  }
  await saveAssetManifest(config, projectId, updated);
}

// ===== PROJECT PERSISTENCE =====

async function saveProjectsToOSS(config, projects) {
  const blob = new Blob([JSON.stringify(projects)], { type: "application/json" });
  const putUrl = await generateOSSPresignedUrl(config, "projects/projects.json", "PUT", 3600, "application/json");
  const res = await fetch(putUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: blob,
  });
  if (!res.ok) throw new Error(`OSS projects PUT failed: ${res.status}`);
}

async function loadProjectsFromOSS(config) {
  try {
    const getUrl = await generateOSSPresignedUrl(config, "projects/projects.json", "GET", 300);
    const res = await fetch(getUrl);
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

// 从 File 对象提取视频元数据（时长、分辨率）
function probeVideoFile(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      resolve({
        duration: isFinite(video.duration) ? video.duration : null,
        width: video.videoWidth || null,
        height: video.videoHeight || null,
      });
      URL.revokeObjectURL(url);
    };
    video.onerror = () => {
      resolve({ duration: null, width: null, height: null });
      URL.revokeObjectURL(url);
    };
    video.src = url;
  });
}

// 从 File 对象提取图片元数据（分辨率）
function probeImageFile(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight, duration: null });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve({ width: null, height: null, duration: null });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

// ===== SECTION 4: REDUCER =====

// 从 window._ENV_ 读取运行时环境变量（Docker 注入），回退到空字符串
const _env = window._ENV_ || {};

const initialState = {
  config: {
    ossRegion: _env.OSS_REGION || "",
    ossBucket: _env.OSS_BUCKET || "",
    ossAccessKeyId: _env.OSS_ACCESS_KEY_ID || "",
    ossAccessKeySecret: _env.OSS_ACCESS_KEY_SECRET || "",
    qwenApiKey: _env.QWEN_API_KEY || "",
  },
  // 若环境变量已全部注入，配置面板默认收起
  configPanelOpen: !Object.values(_env).every(v => v && v.trim() !== ""),

  upload: {
    phase: "idle", // 'idle'|'validating'|'uploading'|'done'|'error'
    file: null,
    objectKey: null,
    signedPlayUrl: null,
    progress: 0,
    errorCode: null,
    errorMessage: "",
    isImage: false,
  },

  prompt: {
    text: DEFAULT_PROMPT,
    isDefault: true,
  },

  analysis: {
    status: "idle", // 'idle'|'streaming'|'done'|'error'|'timeout'
    streamBuffer: "",
    errorMessage: "",
    startedAt: null,
    elapsedMs: null,
  },

  history: [],
  activeHistoryIdx: 0,

  // v1.1: OSS 持久化历史
  ossHistory: {
    status: "idle", // 'idle'|'loading'|'loaded'|'error'
    entries: [],
    errorMessage: "",
  },
  historyDrawerOpen: false,
  historyDrawerProjectFilter: null,  // string | null，null = 不过滤
  persistError: "",
  qwenConnStatus: "idle", // 'idle'|'checking'|'ok'|'error'

  // v1.1: 多视频上传队列
  queue: {
    items: [],   // QueueItem[]
    activeId: null,
  },

  // v2.0: 工程项目维度管理
  projects: {
    status: "idle", // 'idle'|'loading'|'loaded'|'error'
    list: [],
    errorMessage: "",
  },
  currentPage: "library",   // 'library' | 'analysis' | 'projects'
  selectedProjectId: null,   // 上传时选择的项目 ID

  // v3.0: 资产库
  assetLibrary: {
    status: "idle",          // 'idle'|'loading'|'loaded'|'error'
    assets: [],              // AssetEntry[]
    selectedAssetId: null,   // string | null
    filterProjectId: null,   // string | null
    filterType: "all",       // 'all'|'video'|'image'
    sortOrder: "desc",       // 'desc'|'asc'
    errorMessage: "",
  },
};

function appReducer(state, action) {
  switch (action.type) {
    case "SET_CONFIG":
      return { ...state, config: { ...state.config, ...action.payload } };

    case "TOGGLE_CONFIG_PANEL":
      return { ...state, configPanelOpen: !state.configPanelOpen };

    case "CLOSE_CONFIG_PANEL":
      return { ...state, configPanelOpen: false };

    case "FILE_SELECTED":
      return {
        ...state,
        upload: {
          ...initialState.upload,
          phase: "validating",
          file: action.payload.file,
          objectKey: action.payload.objectKey,
        },
      };

    case "UPLOAD_START":
      return {
        ...state,
        upload: { ...state.upload, phase: "uploading", progress: 0 },
      };

    case "UPLOAD_PROGRESS":
      return {
        ...state,
        upload: { ...state.upload, progress: action.payload },
      };

    case "UPLOAD_DONE":
      return {
        ...state,
        upload: {
          ...state.upload,
          phase: "done",
          progress: 100,
          signedPlayUrl: action.payload.signedPlayUrl,
        },
      };

    case "UPLOAD_ERROR":
      return {
        ...state,
        upload: {
          ...state.upload,
          phase: "error",
          errorCode: action.payload.errorCode,
          errorMessage: action.payload.errorMessage,
        },
      };

    case "RESET_UPLOAD":
      return {
        ...state,
        upload: { ...initialState.upload },
        analysis: { ...initialState.analysis },
        history: [],
        activeHistoryIdx: 0,
        queue: { items: [], activeId: null },
      };

    case "SET_PROMPT":
      return {
        ...state,
        prompt: {
          text: action.payload,
          isDefault: action.payload === DEFAULT_PROMPT,
        },
      };

    case "RESET_PROMPT":
      return { ...state, prompt: { text: DEFAULT_PROMPT, isDefault: true } };

    case "ANALYSIS_START":
      return {
        ...state,
        analysis: {
          status: "streaming",
          streamBuffer: "",
          errorMessage: "",
          startedAt: action.payload.startedAt,
          elapsedMs: null,
        },
      };

    case "ANALYSIS_TOKEN":
      return {
        ...state,
        analysis: {
          ...state.analysis,
          streamBuffer: state.analysis.streamBuffer + action.payload,
        },
      };

    case "ANALYSIS_DONE": {
      const entry = {
        id: `${Date.now()}`,
        timestamp: new Date(),
        promptUsed: state.prompt.text,
        resultText: state.analysis.streamBuffer,
        elapsedMs: action.payload.elapsedMs,
        videoObjectKey: state.upload.objectKey,
        projectId: state.selectedProjectId,
        isImage: state.upload.isImage,
      };
      const newHistory = [entry, ...state.history].slice(0, 3);
      return {
        ...state,
        analysis: {
          ...state.analysis,
          status: "done",
          elapsedMs: action.payload.elapsedMs,
        },
        history: newHistory,
        activeHistoryIdx: 0,
      };
    }

    case "ANALYSIS_ERROR":
      return {
        ...state,
        analysis: {
          ...state.analysis,
          status: "error",
          errorMessage: action.payload.errorMessage,
        },
      };

    case "ANALYSIS_TIMEOUT":
      return {
        ...state,
        analysis: {
          ...state.analysis,
          status: "timeout",
          errorMessage: "分析超时，请重试或上传较短片段",
        },
      };

    case "SELECT_HISTORY_TAB":
      return { ...state, activeHistoryIdx: action.payload };

    // ===== v1.1: PERSISTENCE ACTIONS =====
    case "OSS_SAVE_ERROR":
      return { ...state, persistError: action.payload.message };
    case "CLEAR_PERSIST_ERROR":
      return { ...state, persistError: "" };

    case "QWEN_CONN_CHECKING":
      return { ...state, qwenConnStatus: "checking" };
    case "QWEN_CONN_OK":
      return { ...state, qwenConnStatus: "ok" };
    case "QWEN_CONN_ERROR":
      return { ...state, qwenConnStatus: "error" };

    // ===== v1.1: HISTORY DRAWER ACTIONS =====
    case "OSS_HISTORY_LOADING":
      return { ...state, ossHistory: { ...state.ossHistory, status: "loading" } };
    case "OSS_HISTORY_LOADED":
      return { ...state, ossHistory: { status: "loaded", entries: action.payload.entries, errorMessage: "" } };
    case "OSS_HISTORY_ERROR":
      return { ...state, ossHistory: { ...state.ossHistory, status: "error", errorMessage: action.payload.message } };
    case "TOGGLE_HISTORY_DRAWER":
      return { ...state, historyDrawerOpen: !state.historyDrawerOpen, historyDrawerProjectFilter: null };
    case "CLOSE_HISTORY_DRAWER":
      return { ...state, historyDrawerOpen: false, historyDrawerProjectFilter: null };
    case "OPEN_HISTORY_DRAWER_FOR_PROJECT":
      return { ...state, historyDrawerOpen: true, historyDrawerProjectFilter: action.payload };
    case "OSS_HISTORY_ENTRY_DELETED":
      return {
        ...state,
        ossHistory: {
          ...state.ossHistory,
          entries: state.ossHistory.entries.filter(e => e.id !== action.payload.id),
        },
      };
    case "OSS_HISTORY_ENTRY_ADDED":
      return {
        ...state,
        ossHistory: {
          ...state.ossHistory,
          entries: [action.payload.entry, ...state.ossHistory.entries],
        },
      };
    case "RESTORE_FROM_HISTORY": {
      const { entry, signedPlayUrl } = action.payload;
      return {
        ...state,
        currentPage: "analysis",
        upload: {
          phase: "done", file: null,
          objectKey: entry.videoObjectKey,
          signedPlayUrl,
          progress: 100, errorCode: null, errorMessage: "",
          isImage: entry.isImage ?? false,
        },
        history: [entry],
        activeHistoryIdx: 0,
        historyDrawerOpen: false,
        historyDrawerProjectFilter: null,
        analysis: { ...initialState.analysis },
        selectedProjectId: entry.projectId || null,
      };
    }

    // ===== v1.1: QUEUE ACTIONS =====
    case "QUEUE_ADD":
      return { ...state, queue: { items: action.payload.items, activeId: null } };
    case "QUEUE_ITEM_START":
      return {
        ...state,
        queue: {
          ...state.queue,
          activeId: action.payload.id,
          items: state.queue.items.map(i =>
            i.id === action.payload.id ? { ...i, status: "uploading" } : i
          ),
        },
      };
    case "QUEUE_ITEM_PROGRESS":
      return {
        ...state,
        queue: {
          ...state.queue,
          items: state.queue.items.map(i =>
            i.id === action.payload.id ? { ...i, progress: action.payload.progress } : i
          ),
        },
      };
    case "QUEUE_ITEM_DONE": {
      const { id, signedPlayUrl: qSignedUrl } = action.payload;
      const doneItem = state.queue.items.find(i => i.id === id);
      return {
        ...state,
        queue: {
          items: state.queue.items.map(i =>
            i.id === id ? { ...i, status: "done", progress: 100, signedPlayUrl: qSignedUrl } : i
          ),
          activeId: null,
        },
        upload: {
          phase: "done",
          file: doneItem?.file || null,
          objectKey: doneItem?.objectKey || null,
          signedPlayUrl: qSignedUrl,
          progress: 100,
          errorCode: null,
          errorMessage: "",
          isImage: doneItem?.isImage ?? false,
        },
        analysis: { ...initialState.analysis },
      };
    }
    case "QUEUE_ITEM_FAILED":
      return {
        ...state,
        queue: {
          items: state.queue.items.map(i =>
            i.id === action.payload.id
              ? { ...i, status: "failed", errorMessage: action.payload.errorMessage }
              : i
          ),
          activeId: null,
        },
      };
    case "QUEUE_CLEAR":
      return { ...state, queue: { items: [], activeId: null } };

    case "SWITCH_TO_QUEUE_ITEM": {
      const { item } = action.payload;
      return {
        ...state,
        upload: {
          phase: "done",
          file: item.file || null,
          objectKey: item.objectKey,
          signedPlayUrl: item.signedPlayUrl,
          progress: 100,
          errorCode: null,
          errorMessage: "",
          isImage: item.isImage ?? false,
        },
        analysis: { ...initialState.analysis },
      };
    }

    // ===== v2.0: PROJECT ACTIONS =====
    case "PROJECTS_LOADING":
      return { ...state, projects: { ...state.projects, status: "loading" } };
    case "PROJECTS_LOADED":
      return { ...state, projects: { status: "loaded", list: action.payload.list, errorMessage: "" } };
    case "PROJECTS_ERROR":
      return { ...state, projects: { ...state.projects, status: "error", errorMessage: action.payload.message } };
    case "NAVIGATE_TO_PROJECTS":
      return { ...state, currentPage: "projects" };
    case "NAVIGATE_TO_ANALYSIS":
      return { ...state, currentPage: "analysis" };
    case "SET_SELECTED_PROJECT":
      return { ...state, selectedProjectId: action.payload };
    case "PROJECT_ADDED":
      return { ...state, projects: { ...state.projects, list: [...state.projects.list, action.payload] } };
    case "PROJECT_UPDATED":
      return {
        ...state,
        projects: {
          ...state.projects,
          list: state.projects.list.map(p => p.id === action.payload.id ? action.payload : p),
        },
      };
    case "PROJECT_DELETED":
      return {
        ...state,
        projects: { ...state.projects, list: state.projects.list.filter(p => p.id !== action.payload) },
        selectedProjectId: state.selectedProjectId === action.payload ? null : state.selectedProjectId,
      };

    // ===== v3.0: ASSET LIBRARY ACTIONS =====
    case "NAVIGATE_TO_LIBRARY":
      return { ...state, currentPage: "library" };

    case "ASSET_LIBRARY_LOADING":
      return { ...state, assetLibrary: { ...state.assetLibrary, status: "loading" } };
    case "ASSET_LIBRARY_LOADED":
      return { ...state, assetLibrary: { ...state.assetLibrary, status: "loaded", assets: action.payload.assets, errorMessage: "" } };
    case "ASSET_LIBRARY_ERROR":
      return { ...state, assetLibrary: { ...state.assetLibrary, status: "error", errorMessage: action.payload.message } };
    case "ASSET_LIBRARY_ASSET_ADDED":
      return {
        ...state,
        assetLibrary: { ...state.assetLibrary, assets: [action.payload.asset, ...state.assetLibrary.assets] },
      };

    case "SELECT_ASSET": {
      const asset = state.assetLibrary.assets.find(a => a.id === action.payload);
      if (!asset) return { ...state, assetLibrary: { ...state.assetLibrary, selectedAssetId: action.payload } };
      return {
        ...state,
        assetLibrary: { ...state.assetLibrary, selectedAssetId: action.payload },
        upload: {
          phase: "done",
          file: null,
          objectKey: asset.objectKey,
          signedPlayUrl: null, // filled by async handler
          progress: 100,
          errorCode: null,
          errorMessage: "",
          isImage: asset.isImage,
        },
        analysis: { ...initialState.analysis },
        history: [],
        activeHistoryIdx: 0,
        selectedProjectId: asset.projectId || null,
      };
    }

    case "SET_ASSET_FILTER_PROJECT":
      return { ...state, assetLibrary: { ...state.assetLibrary, filterProjectId: action.payload } };
    case "SET_ASSET_FILTER_TYPE":
      return { ...state, assetLibrary: { ...state.assetLibrary, filterType: action.payload } };
    case "SET_ASSET_SORT_ORDER":
      return { ...state, assetLibrary: { ...state.assetLibrary, sortOrder: action.payload } };

    case "ASSET_DELETED": {
      const wasSelected = state.assetLibrary.selectedAssetId === action.payload;
      return {
        ...state,
        assetLibrary: {
          ...state.assetLibrary,
          assets: state.assetLibrary.assets.filter(a => a.id !== action.payload),
          selectedAssetId: wasSelected ? null : state.assetLibrary.selectedAssetId,
        },
        ...(wasSelected ? {
          upload: { ...initialState.upload },
          analysis: { ...initialState.analysis },
          history: [],
          activeHistoryIdx: 0,
        } : {}),
      };
    }
    case "ASSET_RENAMED":
      return {
        ...state,
        assetLibrary: {
          ...state.assetLibrary,
          assets: state.assetLibrary.assets.map(a =>
            a.id === action.payload.id
              ? { ...a, filename: action.payload.filename, remark: action.payload.remark }
              : a
          ),
        },
      };

    default:
      return state;
  }
}

// ===== SECTION 5: CUSTOM HOOKS =====

function useOSSPersistence() {
  const persistEntry = useCallback(async (config, entry, dispatch) => {
    try {
      const objectKey = await saveAnalysisToOSS(config, entry);
      await updateOSSIndex(config, objectKey, "add", entry.projectId || null);
    } catch (err) {
      dispatch({ type: "OSS_SAVE_ERROR", payload: { message: err.message } });
    }
  }, []);

  const loadHistory = useCallback(async (config, projectsList, dispatch) => {
    dispatch({ type: "OSS_HISTORY_LOADING" });
    try {
      const entries = await loadAllOSSHistory(config, projectsList);
      dispatch({ type: "OSS_HISTORY_LOADED", payload: { entries } });
    } catch (err) {
      dispatch({ type: "OSS_HISTORY_ERROR", payload: { message: err.message } });
    }
  }, []);

  const deleteEntry = useCallback(async (config, entry, dispatch) => {
    try {
      await deleteOSSHistoryEntry(config, entry);
      dispatch({ type: "OSS_HISTORY_ENTRY_DELETED", payload: { id: entry.id } });
    } catch (err) {
      dispatch({ type: "OSS_SAVE_ERROR", payload: { message: err.message } });
    }
  }, []);

  return { persistEntry, loadHistory, deleteEntry };
}

function useQueueProcessor(state, dispatch, onItemDone) {
  const { upload: ossUpload } = useOSSUpload();

  useEffect(() => {
    const { items, activeId } = state.queue;
    if (activeId !== null) return;
    const next = items.find(i => i.status === "waiting");
    if (!next) return;

    dispatch({ type: "QUEUE_ITEM_START", payload: { id: next.id } });

    const proxyDispatch = (action) => {
      if (action.type === "UPLOAD_PROGRESS") {
        dispatch({ type: "QUEUE_ITEM_PROGRESS", payload: { id: next.id, progress: action.payload } });
      } else if (action.type !== "UPLOAD_START") {
        dispatch(action);
      }
    };

    ossUpload(state.config, next.file, next.objectKey, proxyDispatch)
      .then(async () => {
        const signedPlayUrl = await generateOSSPresignedUrl(state.config, next.objectKey, "GET", 7200);
        dispatch({ type: "QUEUE_ITEM_DONE", payload: { id: next.id, signedPlayUrl } });
        if (onItemDone) onItemDone(next, signedPlayUrl);
      })
      .catch(err => {
        dispatch({
          type: "QUEUE_ITEM_FAILED",
          payload: {
            id: next.id,
            errorMessage: err.message === "CORS_ERROR"
              ? "上传失败：CORS 未配置"
              : `上传失败：${err.message}`,
          },
        });
      });
  }, [state.queue.items, state.queue.activeId]);
}

function useOSSUpload() {
  const upload = useCallback(async (config, file, objectKey, dispatch) => {
    dispatch({ type: "UPLOAD_START" });
    const contentType = file.type || "application/octet-stream";
    const uploadUrl = await generateOSSPresignedUrl(config, objectKey, "PUT", 3600, contentType);

    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", uploadUrl);
      xhr.setRequestHeader("Content-Type", contentType);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          dispatch({ type: "UPLOAD_PROGRESS", payload: pct });
        }
      };

      xhr.onload = () => {
        if (xhr.status === 200) resolve();
        else {
          const isCors = xhr.status === 0;
          reject(
            new Error(
              isCors
                ? "CORS_ERROR"
                : `OSS HTTP ${xhr.status}: ${xhr.responseText}`
            )
          );
        }
      };
      xhr.onerror = () => reject(new Error("CORS_ERROR"));
      xhr.send(file);
    });
  }, []);

  return { upload };
}

function useQwenAnalysis() {
  const analyze = useCallback(
    async (config, signedPlayUrl, promptText, dispatch, abortSignal, isImage = false) => {
      const mediaContent = isImage
        ? { type: "image_url", image_url: { url: signedPlayUrl } }
        : { type: "video_url", video_url: { url: signedPlayUrl } };
      const response = await fetch(QWEN_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.qwenApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "qwen-vl-plus",
          stream: true,
          messages: [
            {
              role: "user",
              content: [
                mediaContent,
                { type: "text", text: promptText },
              ],
            },
          ],
        }),
        signal: abortSignal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API Error ${response.status}: ${errText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") return;
          try {
            const chunk = JSON.parse(data);
            const delta = chunk?.choices?.[0]?.delta?.content;
            if (delta) {
              const token = Array.isArray(delta)
                ? delta.map((d) => d.text || "").join("")
                : delta;
              if (token) dispatch({ type: "ANALYSIS_TOKEN", payload: token });
            }
          } catch {
            // Malformed chunk — skip
          }
        }
      }
    },
    []
  );

  return { analyze };
}

// ===== SECTION 6: SUB-COMPONENTS =====

// --- Inline Markdown Parser ---
function parseInline(text) {
  const parts = [];
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    if (match[2])
      parts.push(
        <strong key={match.index} className="font-semibold">
          {match[2]}
        </strong>
      );
    else if (match[3])
      parts.push(<em key={match.index}>{match[3]}</em>);
    else if (match[4])
      parts.push(
        <code
          key={match.index}
          className="bg-gray-100 px-1 rounded text-sm font-mono"
        >
          {match[4]}
        </code>
      );
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function renderMarkdownLine(line, idx) {
  if (line.startsWith("##### "))
    return (
      <h5 key={idx} className="text-sm font-semibold mt-2 mb-0.5 text-gray-700">
        {parseInline(line.slice(6))}
      </h5>
    );
  if (line.startsWith("#### "))
    return (
      <h4 key={idx} className="text-sm font-bold mt-2 mb-1 text-gray-800">
        {parseInline(line.slice(5))}
      </h4>
    );
  if (line.startsWith("### "))
    return (
      <h3 key={idx} className="text-base font-bold mt-3 mb-1 text-gray-800">
        {parseInline(line.slice(4))}
      </h3>
    );
  if (line.startsWith("## "))
    return (
      <h2 key={idx} className="text-lg font-bold mt-4 mb-2 text-gray-900">
        {parseInline(line.slice(3))}
      </h2>
    );
  if (line.startsWith("# "))
    return (
      <h1 key={idx} className="text-xl font-bold mt-4 mb-2 text-gray-900">
        {parseInline(line.slice(2))}
      </h1>
    );
  if (line.startsWith("- ") || line.startsWith("* "))
    return (
      <li key={idx} className="ml-5 list-disc text-gray-700 leading-relaxed">
        {parseInline(line.slice(2))}
      </li>
    );
  if (/^\d+\. /.test(line))
    return (
      <li
        key={idx}
        className="ml-5 list-decimal text-gray-700 leading-relaxed"
      >
        {parseInline(line.replace(/^\d+\. /, ""))}
      </li>
    );
  if (line.trim() === "") return <div key={idx} className="h-2" />;
  return (
    <p key={idx} className="text-gray-700 leading-relaxed">
      {parseInline(line)}
    </p>
  );
}

function MarkdownRenderer({ text }) {
  const lines = (text || "").split("\n");
  return (
    <div className="space-y-0.5">{lines.map((line, idx) => renderMarkdownLine(line, idx))}</div>
  );
}

// --- Config Panel ---
function ConfigPanel({ config, onSave, onToggle }) {
  const [local, setLocal] = useState({ ...config });
  const allFilled = Object.values(local).every((v) => v.trim() !== "");

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg mx-4 mt-2 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-gray-800 flex items-center gap-2">
          ⚙️ 系统配置
        </h2>
        <button
          onClick={onToggle}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          收起 ∧
        </button>
      </div>
      <div className="bg-amber-100 border border-amber-300 rounded px-3 py-2 mb-4 text-sm text-amber-800">
        ⚠️ 密钥仅保存在内存中，刷新后失效。请勿在公共设备上使用。
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {[
          { key: "ossRegion", label: "OSS 地域 (Region)", placeholder: "oss-cn-hangzhou" },
          { key: "ossBucket", label: "OSS Bucket 名称", placeholder: "anjū-engineering-bucket" },
          { key: "ossAccessKeyId", label: "OSS AccessKey ID", placeholder: "LTAI5t…", secret: true },
          { key: "ossAccessKeySecret", label: "OSS AccessKey Secret", placeholder: "••••••••", secret: true },
          { key: "qwenApiKey", label: "通义千问 API Key", placeholder: "sk-…", secret: true },
        ].map(({ key, label, placeholder, secret }) => (
          <div key={key}>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {label}
            </label>
            <input
              type={secret ? "password" : "text"}
              value={local[key]}
              onChange={(e) => setLocal((p) => ({ ...p, [key]: e.target.value }))}
              placeholder={placeholder}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        ))}
      </div>
      <div className="mt-4 flex justify-end">
        <button
          onClick={() => onSave(local)}
          disabled={!allFilled}
          className="px-5 py-2 bg-blue-700 text-white rounded font-medium text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:bg-blue-800 transition-colors"
        >
          ✓ 保存配置
        </button>
      </div>
    </div>
  );
}

// --- Upload Zone ---
function UploadZone({ onFilesSelected, uploadError, onClearError }) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) onFilesSelected(files);
  }

  function handleChange(e) {
    const files = Array.from(e.target.files);
    if (files.length > 0) onFilesSelected(files);
    e.target.value = "";
  }

  return (
    <div className="flex flex-col gap-3">
      {uploadError && (
        <div className="flex items-center justify-between bg-red-50 border border-red-200 rounded px-3 py-2 text-sm text-red-700">
          <span>{uploadError}</span>
          <button onClick={onClearError} className="ml-2 text-red-500 hover:text-red-700 font-bold">
            ×
          </button>
        </div>
      )}
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`flex flex-col items-center justify-center border-2 border-dashed rounded-xl cursor-pointer transition-colors select-none
          ${dragOver ? "border-blue-500 bg-blue-50" : "border-gray-300 bg-gray-50 hover:bg-gray-100"}`}
        style={{ aspectRatio: "16/9" }}
      >
        <div className="text-4xl mb-3">📹</div>
        <p className="text-gray-600 font-medium text-center px-4">
          拖拽视频文件至此，或点击选择
        </p>
        <p className="text-gray-400 text-sm mt-1">视频：MP4/MOV/AVI ≤200MB · 图片：JPG/PNG/WEBP/GIF ≤20MB · 可多选</p>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".mp4,.mov,.avi,.jpg,.jpeg,.png,.webp,.gif,.bmp,video/mp4,video/quicktime,video/x-msvideo,image/jpeg,image/png,image/webp,image/gif,image/bmp"
        onChange={handleChange}
        className="hidden"
      />
    </div>
  );
}

// --- Queue Panel ---
function QueuePanel({ items, activeObjectKey, onClear, onSwitch }) {
  if (items.length === 0) return null;
  const statusConfig = {
    waiting:   { text: "等待中", cls: "bg-gray-100 text-gray-500" },
    uploading: { text: "上传中", cls: "bg-blue-100 text-blue-700" },
    done:      { text: "完成 ✓", cls: "bg-green-100 text-green-700" },
    failed:    { text: "失败 ✗", cls: "bg-red-100 text-red-700" },
  };
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-gray-700">上传队列（{items.length} 个文件）</span>
        {onClear && <button onClick={onClear} className="text-xs text-gray-400 hover:text-gray-600">清空</button>}
      </div>
      <div className="flex flex-col gap-2">
        {items.map(item => {
          const sc = statusConfig[item.status];
          const isActive = item.objectKey === activeObjectKey;
          const m = item.meta;
          const metaStr = [
            m?.size ? formatFileSize(m.size) : null,
            m?.duration ? `${Math.floor(m.duration / 60)}:${String(Math.floor(m.duration % 60)).padStart(2, "0")}` : null,
            m?.width && m?.height ? `${m.width}×${m.height}` : null,
            m?.lastModified ? new Date(m.lastModified).toLocaleDateString("zh-CN") : null,
          ].filter(Boolean).join("  ·  ");
          return (
            <div key={item.id} className={`flex flex-col gap-1 rounded-lg px-2 py-1.5 ${isActive ? "bg-blue-50 border border-blue-200" : "border border-transparent"}`}>
              <div className="flex items-center justify-between text-xs gap-2">
                <span className="text-gray-700 font-medium truncate max-w-[160px]">{item.file?.name}</span>
                <div className="flex items-center gap-1 shrink-0">
                  {item.status === "done" && !isActive && onSwitch && (
                    <button
                      onClick={() => onSwitch(item)}
                      className="px-2 py-0.5 text-xs bg-blue-50 text-blue-600 border border-blue-200 rounded hover:bg-blue-100"
                    >
                      切换
                    </button>
                  )}
                  {isActive && item.status === "done" && (
                    <span className="px-2 py-0.5 text-xs bg-blue-600 text-white rounded">当前</span>
                  )}
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${sc.cls}`}>{sc.text}</span>
                </div>
              </div>
              {metaStr && (
                <p className="text-xs text-gray-400">{metaStr}</p>
              )}
              {item.status === "uploading" && (
                <div className="w-full bg-gray-200 rounded-full h-1">
                  <div className="bg-blue-500 h-1 rounded-full transition-all" style={{ width: `${item.progress}%` }} />
                </div>
              )}
              {item.status === "failed" && (
                <p className="text-xs text-red-500">{item.errorMessage}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- History Drawer ---
function HistoryDrawer({ open, ossHistory, projectsList, filterProjectId, onClose, onRestore, onDelete }) {
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const filterProject = filterProjectId ? (projectsList || []).find(p => p.id === filterProjectId) : null;
  const filteredEntries = filterProjectId
    ? (ossHistory.entries || []).filter(e => e.projectId === filterProjectId)
    : (ossHistory.entries || []);

  const grouped = {};
  filteredEntries.forEach(entry => {
    const key = new Date(entry.timestamp).toLocaleDateString("zh-CN");
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(entry);
  });

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 bg-black bg-opacity-30 z-40"
          onClick={onClose}
        />
      )}
      {/* Drawer */}
      <div className={`fixed right-0 top-0 h-full w-80 bg-white shadow-2xl z-50 flex flex-col transition-transform duration-300
        ${open ? "translate-x-0" : "translate-x-full"}`}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
          <h2 className="font-semibold text-gray-800 truncate">
            {filterProject ? `📁 ${filterProject.name} · 分析记录` : "📋 历史分析记录"}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-3">
          {ossHistory.status === "loading" && (
            <div className="flex items-center justify-center h-32 text-gray-400 text-sm">
              <svg className="animate-spin h-4 w-4 mr-2" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              加载中…
            </div>
          )}
          {ossHistory.status === "error" && (
            <div className="text-red-500 text-sm p-3 bg-red-50 rounded">{ossHistory.errorMessage}</div>
          )}
          {(ossHistory.status === "loaded" || ossHistory.status === "idle") && filteredEntries.length === 0 && (
            <div className="text-gray-400 text-sm text-center mt-12">
              {filterProjectId ? "该项目暂无分析记录" : "暂无历史记录"}
            </div>
          )}
          {Object.entries(grouped).map(([date, entries]) => (
            <div key={date} className="mb-4">
              <div className="text-xs font-medium text-gray-400 mb-2 px-1">{date}</div>
              {entries.map(entry => (
                <div key={entry.id} className="bg-gray-50 rounded-lg p-3 mb-2 border border-gray-100">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-400 mb-1 flex items-center gap-1.5 flex-wrap">
                        <span>{new Date(entry.timestamp).toLocaleTimeString("zh-CN")} · {formatElapsed(entry.elapsedMs)}</span>
                        {(() => {
                          const proj = (projectsList || []).find(p => p.id === entry.projectId);
                          return proj
                            ? <span className="px-1.5 py-0.5 bg-blue-50 text-blue-600 rounded text-xs">📁 {proj.name}</span>
                            : entry.projectId === null || entry.projectId === undefined
                              ? <span className="px-1.5 py-0.5 bg-gray-100 text-gray-400 rounded text-xs">未分类</span>
                              : null;
                        })()}
                      </p>
                      <p className="text-sm text-gray-700 line-clamp-2 leading-relaxed">
                        {(entry.resultText || "").slice(0, 80)}…
                      </p>
                    </div>
                    <div className="flex flex-col gap-1 shrink-0">
                      <button
                        onClick={() => onRestore(entry)}
                        title="恢复"
                        className="text-xs px-2 py-1 bg-blue-50 text-blue-600 rounded hover:bg-blue-100"
                      >
                        恢复
                      </button>
                      {confirmDeleteId === entry.id ? (
                        <div className="flex gap-1">
                          <button
                            onClick={() => { onDelete(entry); setConfirmDeleteId(null); }}
                            className="text-xs px-1.5 py-1 bg-red-500 text-white rounded hover:bg-red-600"
                          >确认</button>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className="text-xs px-1.5 py-1 bg-gray-200 text-gray-600 rounded"
                          >取消</button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmDeleteId(entry.id)}
                          title="删除"
                          className="text-xs px-2 py-1 bg-gray-100 text-gray-500 rounded hover:bg-red-50 hover:text-red-500"
                        >
                          删除
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// --- Project Selector ---
function ProjectSelector({ projectsList, selectedProjectId, onSelect, onCreateNew }) {
  const selectedProject = projectsList.find(p => p.id === selectedProjectId);
  const PHASE_COLORS = { 基础: "bg-yellow-100 text-yellow-700", 主体: "bg-blue-100 text-blue-700", 装修: "bg-purple-100 text-purple-700", 竣工: "bg-green-100 text-green-700" };

  return (
    <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-3 py-2">
      <span className="text-xs text-gray-500 shrink-0">🏗 所属项目：</span>
      <select
        value={selectedProjectId || ""}
        onChange={e => onSelect(e.target.value || null)}
        className="flex-1 text-sm border-0 bg-transparent focus:outline-none text-gray-700 cursor-pointer min-w-0"
      >
        <option value="">未分类</option>
        {projectsList.map(p => (
          <option key={p.id} value={p.id}>
            {p.name}{p.code ? ` (${p.code})` : ""}
          </option>
        ))}
      </select>
      {selectedProject?.phase && (
        <span className={`text-xs px-1.5 py-0.5 rounded-full shrink-0 ${PHASE_COLORS[selectedProject.phase] || "bg-gray-100 text-gray-500"}`}>
          {selectedProject.phase}
        </span>
      )}
      <button
        onClick={onCreateNew}
        className="text-xs text-blue-600 hover:text-blue-800 shrink-0 font-medium"
        title="新建项目"
      >
        + 新建
      </button>
    </div>
  );
}

// --- Upload Progress ---
function UploadProgress({ progress, filename, fileSize }) {
  return (
    <div className="mt-3 bg-white border border-gray-200 rounded-lg p-4">
      <div className="flex justify-between text-sm text-gray-600 mb-2">
        <span className="truncate max-w-xs">{filename}</span>
        <span>{formatFileSize(fileSize)}</span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-2">
        <div
          className="bg-blue-600 h-2 rounded-full transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>
      <div className="text-right text-sm text-gray-500 mt-1">{progress}%</div>
    </div>
  );
}

// --- Video Player ---
function VideoPlayer({ src, filename, fileSize, onError }) {
  const videoRef = useRef(null);
  const [speed, setSpeed] = useState(1);

  function changeSpeed(s) {
    setSpeed(s);
    if (videoRef.current) videoRef.current.playbackRate = s;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="relative bg-black rounded-xl overflow-hidden" style={{ aspectRatio: "16/9" }}>
        <video
          ref={videoRef}
          src={src}
          controls
          autoPlay
          className="w-full h-full object-contain"
          onError={onError}
        />
      </div>
      <div className="flex items-center justify-between px-1">
        <div className="text-sm text-gray-600 truncate max-w-xs">
          {filename && <span>{filename}</span>}
          {fileSize && <span className="text-gray-400 ml-2">({formatFileSize(fileSize)})</span>}
        </div>
        <div className="flex items-center gap-1 text-sm">
          <span className="text-gray-500 mr-1">速度：</span>
          {[0.5, 1, 1.5, 2].map((s) => (
            <button
              key={s}
              onClick={() => changeSpeed(s)}
              className={`px-2 py-0.5 rounded text-xs font-medium transition-colors
                ${speed === s ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// --- Image Preview ---
function ImagePreview({ src, filename }) {
  return (
    <div
      className="relative bg-black rounded-xl overflow-hidden"
      style={{ aspectRatio: "16/9" }}
    >
      <img
        src={src}
        alt={filename || "图片预览"}
        className="w-full h-full object-contain"
      />
    </div>
  );
}

// --- Prompt Editor ---
function PromptEditor({ prompt, onPromptChange, onQuickTag, onReset }) {
  const remaining = MAX_PROMPT_CHARS - prompt.length;
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-gray-700 text-sm">📝 分析提示词</h3>
        {!prompt.isDefault && (
          <button
            onClick={onReset}
            className="text-xs text-blue-600 hover:text-blue-800 underline"
          >
            恢复默认
          </button>
        )}
      </div>
      <textarea
        value={prompt.text}
        onChange={(e) => onPromptChange(e.target.value)}
        maxLength={MAX_PROMPT_CHARS}
        rows={4}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-400 text-gray-700"
        placeholder="请输入分析提示词…"
      />
      <div className="text-right text-xs text-gray-400">剩余 {remaining} 字</div>
      <div className="flex flex-wrap gap-1.5">
        {QUICK_TAGS.map((tag) => (
          <button
            key={tag.label}
            onClick={() => onQuickTag(tag.appendText)}
            className="text-xs px-2.5 py-1 bg-blue-50 text-blue-700 border border-blue-200 rounded-full hover:bg-blue-100 transition-colors"
          >
            + {tag.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// --- Analysis Button ---
function AnalysisButton({ status, onClick, disabled }) {
  const configs = {
    idle: {
      text: "开始视频分析",
      cls: "bg-blue-700 hover:bg-blue-800 text-white",
      loading: false,
    },
    streaming: {
      text: "分析中…",
      cls: "bg-gray-400 text-white cursor-not-allowed",
      loading: true,
    },
    done: {
      text: "重新分析",
      cls: "bg-gray-100 hover:bg-gray-200 text-gray-700 border border-gray-300",
      loading: false,
    },
    error: {
      text: "重新分析",
      cls: "bg-gray-100 hover:bg-gray-200 text-gray-700 border border-gray-300",
      loading: false,
    },
    timeout: {
      text: "重新分析",
      cls: "bg-gray-100 hover:bg-gray-200 text-gray-700 border border-gray-300",
      loading: false,
    },
  };
  const cfg = configs[status] || configs.idle;

  return (
    <button
      onClick={onClick}
      disabled={disabled || status === "streaming"}
      className={`w-full py-3 rounded-xl font-semibold text-sm transition-colors flex items-center justify-center gap-2
        ${cfg.cls} ${disabled && status !== "streaming" ? "opacity-40 cursor-not-allowed" : ""}`}
    >
      {cfg.loading && (
        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
        </svg>
      )}
      {cfg.text}
    </button>
  );
}

// --- Result Tabs ---
function ResultTabs({ results, activeIdx, onSelect }) {
  if (results.length === 0) return null;
  return (
    <div className="flex gap-1 mb-2 border-b border-gray-200">
      {results.map((r, i) => (
        <button
          key={r.id}
          onClick={() => onSelect(i)}
          className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px
            ${activeIdx === i
              ? "border-blue-600 text-blue-700"
              : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
        >
          第 {results.length - i} 次分析
        </button>
      ))}
    </div>
  );
}

// --- Result Card ---
function ResultCard({ result, streamBuffer, isStreaming }) {
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const text = isStreaming ? streamBuffer : result?.resultText || "";

  async function handleCopy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleExport() {
    const ts = (result?.timestamp || new Date())
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, "-");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `分析报告_${ts}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!text && !isStreaming) return null;

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 flex flex-col gap-4">
      {/* Header row */}
      <div className="flex items-start justify-between gap-4">
        <div className="text-xs text-gray-400 space-y-0.5">
          {result?.timestamp && (
            <div>🕐 {result.timestamp.toLocaleString("zh-CN")}</div>
          )}
          {result?.elapsedMs != null && (
            <div>⏱ 耗时 {formatElapsed(result.elapsedMs)}</div>
          )}
          {isStreaming && (
            <div className="text-blue-500 flex items-center gap-1">
              <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              分析中…
            </div>
          )}
        </div>
        {!isStreaming && text && (
          <div className="flex gap-2">
            <button
              onClick={handleCopy}
              className="text-xs px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-lg transition-colors"
            >
              {copied ? "✓ 已复制" : "复制"}
            </button>
            <button
              onClick={handleExport}
              className="text-xs px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-lg transition-colors"
            >
              导出 .txt
            </button>
          </div>
        )}
      </div>

      {/* Used prompt (collapsible) */}
      {result?.promptUsed && (
        <div className="border border-gray-100 rounded-lg overflow-hidden">
          <button
            onClick={() => setPromptExpanded((p) => !p)}
            className="w-full flex justify-between items-center px-3 py-2 bg-gray-50 text-xs text-gray-500 hover:bg-gray-100 transition-colors"
          >
            <span>📋 使用的提示词</span>
            <span>{promptExpanded ? "∧" : "∨"}</span>
          </button>
          {promptExpanded && (
            <div className="px-3 py-2 text-xs text-gray-600 bg-white whitespace-pre-wrap">
              {result.promptUsed}
            </div>
          )}
        </div>
      )}

      {/* Analysis content */}
      <div className="min-h-[80px]">
        <MarkdownRenderer text={text} />
        {isStreaming && (
          <span className="inline-block w-0.5 h-4 bg-blue-600 ml-0.5 animate-pulse align-middle" />
        )}
      </div>
    </div>
  );
}

// --- Project Form Modal ---
const PHASE_OPTIONS = ["", "基础", "主体", "装修", "竣工"];
const PHASE_LABELS = { 基础: "基础工程", 主体: "主体结构", 装修: "装修施工", 竣工: "竣工验收" };
const PHASE_COLORS = { 基础: "bg-yellow-100 text-yellow-700", 主体: "bg-blue-100 text-blue-700", 装修: "bg-purple-100 text-purple-700", 竣工: "bg-green-100 text-green-700" };

function ProjectFormModal({ initial, onSave, onCancel }) {
  const [form, setForm] = useState({
    name: "", code: "", address: "", manager: "",
    startDate: "", expectedEndDate: "", phase: "",
    ...initial,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function set(key, value) { setForm(p => ({ ...p, [key]: value })); }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim()) { setError("项目名称不能为空"); return; }
    setSaving(true);
    try {
      await onSave(form);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-semibold text-gray-800">{initial?.id ? "编辑项目" : "新建工程项目"}</h3>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-700 text-xl">×</button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="block text-xs font-medium text-gray-600 mb-1">项目名称 <span className="text-red-500">*</span></label>
            <input value={form.name} onChange={e => set("name", e.target.value)} placeholder="如：安居花园 A 栋" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">项目编号</label>
            <input value={form.code} onChange={e => set("code", e.target.value)} placeholder="如：AJ-2026-001" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">项目负责人</label>
            <input value={form.manager} onChange={e => set("manager", e.target.value)} placeholder="姓名" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
          </div>
          <div className="col-span-2">
            <label className="block text-xs font-medium text-gray-600 mb-1">施工地址</label>
            <input value={form.address} onChange={e => set("address", e.target.value)} placeholder="如：广东省深圳市南山区…" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">开工日期</label>
            <input type="date" value={form.startDate} onChange={e => set("startDate", e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">预计竣工日期</label>
            <input type="date" value={form.expectedEndDate} onChange={e => set("expectedEndDate", e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400" />
          </div>
          <div className="col-span-2">
            <label className="block text-xs font-medium text-gray-600 mb-1">当前阶段</label>
            <select value={form.phase} onChange={e => set("phase", e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400">
              <option value="">— 未设置 —</option>
              {PHASE_OPTIONS.filter(Boolean).map(p => <option key={p} value={p}>{PHASE_LABELS[p]}</option>)}
            </select>
          </div>
          {error && <div className="col-span-2 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}
          <div className="col-span-2 flex justify-end gap-3 pt-2">
            <button type="button" onClick={onCancel} className="px-5 py-2 rounded-lg text-sm text-gray-600 bg-gray-100 hover:bg-gray-200">取消</button>
            <button type="submit" disabled={saving} className="px-5 py-2 rounded-lg text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-40">
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- Project Management Page ---
function ProjectManagementPage({ projects, ossHistory, config, onBack, onProjectAdded, onProjectUpdated, onProjectDeleted, onViewHistory }) {
  const [modalState, setModalState] = useState(null); // null | { mode: 'create' } | { mode: 'edit', project }
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  function getEntryCount(projectId) {
    return (ossHistory.entries || []).filter(e => e.projectId === projectId).length;
  }

  async function handleSave(form) {
    if (modalState?.mode === "create") {
      const project = { ...form, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
      const updatedList = [...projects.list, project];
      await saveProjectsToOSS(config, updatedList);
      onProjectAdded(project);
    } else {
      const project = { ...modalState.project, ...form };
      const updatedList = projects.list.map(p => p.id === project.id ? project : p);
      await saveProjectsToOSS(config, updatedList);
      onProjectUpdated(project);
    }
    setModalState(null);
  }

  async function handleDelete(projectId) {
    const updatedList = projects.list.filter(p => p.id !== projectId);
    await saveProjectsToOSS(config, updatedList);
    onProjectDeleted(projectId);
    setConfirmDeleteId(null);
  }

  return (
    <main className="flex-1 p-4">
      <div className="max-w-4xl mx-auto">
        {/* Page header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <button onClick={onBack} className="text-sm text-gray-500 hover:text-gray-800 flex items-center gap-1">
              ← 返回
            </button>
            <h2 className="text-lg font-semibold text-gray-800">📁 工程项目管理</h2>
          </div>
          <button
            onClick={() => setModalState({ mode: "create" })}
            className="px-4 py-2 bg-blue-700 text-white rounded-xl text-sm font-medium hover:bg-blue-800 transition-colors"
          >
            + 新建项目
          </button>
        </div>

        {/* Loading / Error states */}
        {projects.status === "loading" && (
          <div className="text-center text-gray-400 py-16 text-sm">加载中…</div>
        )}
        {projects.status === "error" && (
          <div className="text-center text-red-500 py-16 text-sm">{projects.errorMessage}</div>
        )}

        {/* Empty state */}
        {(projects.status === "loaded" || projects.status === "idle") && projects.list.length === 0 && (
          <div className="text-center py-20">
            <div className="text-6xl mb-4">🏗</div>
            <p className="text-gray-500 mb-2">暂无工程项目</p>
            <p className="text-gray-400 text-sm mb-6">创建项目后，上传视频时可将分析结果归档到对应项目</p>
            <button
              onClick={() => setModalState({ mode: "create" })}
              className="px-6 py-2.5 bg-blue-700 text-white rounded-xl text-sm font-medium hover:bg-blue-800"
            >
              + 新建第一个项目
            </button>
          </div>
        )}

        {/* Project cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {projects.list.map(project => {
            const entryCount = getEntryCount(project.id);
            return (
              <div key={project.id} className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm hover:shadow-md transition-shadow">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="min-w-0">
                    <h3 className="font-semibold text-gray-900 truncate">{project.name}</h3>
                    {project.code && <p className="text-xs text-gray-400 mt-0.5">{project.code}</p>}
                  </div>
                  {project.phase && (
                    <span className={`text-xs px-2 py-1 rounded-full shrink-0 font-medium ${PHASE_COLORS[project.phase] || "bg-gray-100 text-gray-500"}`}>
                      {project.phase}
                    </span>
                  )}
                </div>
                <div className="space-y-1.5 text-sm text-gray-600 mb-4">
                  {project.address && (
                    <div className="flex items-start gap-1.5">
                      <span className="text-gray-400 shrink-0">📍</span>
                      <span className="truncate">{project.address}</span>
                    </div>
                  )}
                  {project.manager && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-gray-400">👤</span>
                      <span>{project.manager}</span>
                    </div>
                  )}
                  {(project.startDate || project.expectedEndDate) && (
                    <div className="flex items-center gap-1.5 text-xs text-gray-500">
                      <span className="text-gray-400">📅</span>
                      <span>
                        {project.startDate || "—"} → {project.expectedEndDate || "—"}
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-400">
                    <button
                      onClick={() => entryCount > 0 && onViewHistory(project.id)}
                      className={`text-xs ${entryCount > 0 ? "text-blue-500 hover:text-blue-700 hover:underline cursor-pointer" : "text-gray-400 cursor-default"}`}
                    >
                      📊 {entryCount} 条分析记录
                    </button>
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setModalState({ mode: "edit", project })}
                      className="text-xs px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-lg"
                    >
                      编辑
                    </button>
                    {confirmDeleteId === project.id ? (
                      <div className="flex gap-1">
                        <button
                          onClick={() => handleDelete(project.id)}
                          className="text-xs px-2.5 py-1.5 bg-red-500 hover:bg-red-600 text-white rounded-lg"
                        >确认删除</button>
                        <button
                          onClick={() => setConfirmDeleteId(null)}
                          className="text-xs px-2.5 py-1.5 bg-gray-200 text-gray-600 rounded-lg"
                        >取消</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteId(project.id)}
                        className="text-xs px-3 py-1.5 bg-gray-100 hover:bg-red-50 hover:text-red-500 text-gray-500 rounded-lg"
                      >
                        删除
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Modal */}
      {modalState && (
        <ProjectFormModal
          initial={modalState.mode === "edit" ? modalState.project : undefined}
          onSave={handleSave}
          onCancel={() => setModalState(null)}
        />
      )}
    </main>
  );
}

// ===== v3.0: ASSET LIBRARY COMPONENTS =====

// --- Asset Rename Modal ---
function AssetRenameModal({ asset, onSave, onCancel }) {
  const [filename, setFilename] = useState(asset.filename);
  const [remark, setRemark] = useState(asset.remark || "");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!filename.trim()) return;
    setSaving(true);
    try {
      await onSave(filename.trim(), remark.trim());
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="font-semibold text-gray-800">重命名 / 备注</h3>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-700 text-xl">×</button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 flex flex-col gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">文件名 <span className="text-red-500">*</span></label>
            <input
              value={filename}
              onChange={e => setFilename(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">备注</label>
            <input
              value={remark}
              onChange={e => setRemark(e.target.value)}
              placeholder="可选备注…"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onCancel} className="px-5 py-2 rounded-lg text-sm text-gray-600 bg-gray-100 hover:bg-gray-200">取消</button>
            <button type="submit" disabled={saving || !filename.trim()} className="px-5 py-2 rounded-lg text-sm font-medium text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-40">
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --- Asset List (left panel) ---
function AssetList({ assets, selectedAssetId, filterProjectId, filterType, sortOrder, projectsList, onSelect, onFilterProject, onFilterType, onSortOrder, onDelete, onRename }) {
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  let filtered = assets;
  if (filterProjectId) filtered = filtered.filter(a => a.projectId === filterProjectId);
  if (filterType === "video") filtered = filtered.filter(a => !a.isImage);
  if (filterType === "image") filtered = filtered.filter(a => a.isImage);
  if (sortOrder === "asc") filtered = [...filtered].sort((a, b) => new Date(a.uploadedAt) - new Date(b.uploadedAt));

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* 筛选条 */}
      <div className="px-2 py-1.5 border-b border-gray-100 flex items-center gap-1.5 flex-wrap shrink-0">
        <select
          value={filterProjectId || ""}
          onChange={e => onFilterProject(e.target.value || null)}
          className="text-xs border border-gray-200 rounded px-1.5 py-1 bg-white text-gray-700 focus:outline-none flex-1 min-w-0"
        >
          <option value="">全部项目</option>
          {projectsList.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className="flex items-center rounded border border-gray-200 overflow-hidden text-xs shrink-0">
          {["all", "video", "image"].map((t, i) => (
            <button
              key={t}
              onClick={() => onFilterType(t)}
              className={`px-1.5 py-1 ${i > 0 ? "border-l border-gray-200" : ""} ${filterType === t ? "bg-blue-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}
            >
              {t === "all" ? "全部" : t === "video" ? "视频" : "图片"}
            </button>
          ))}
        </div>
        <button
          onClick={() => onSortOrder(sortOrder === "desc" ? "asc" : "desc")}
          className="text-xs px-1.5 py-1 border border-gray-200 rounded bg-white text-gray-600 hover:bg-gray-50 shrink-0"
          title="切换排序"
        >
          {sortOrder === "desc" ? "↓" : "↑"}
        </button>
      </div>

      {/* 资产列表 */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-48 text-gray-400 text-sm gap-2">
            <div className="text-3xl">🗂</div>
            <p>暂无资产</p>
          </div>
        )}
        {filtered.map(asset => {
          const isSelected = asset.id === selectedAssetId;
          const proj = projectsList.find(p => p.id === asset.projectId);
          return (
            <div
              key={asset.id}
              onClick={() => onSelect(asset.id)}
              className={`px-3 py-2.5 border-b border-gray-100 cursor-pointer transition-colors ${isSelected ? "bg-blue-50 border-l-2 border-l-blue-500" : "hover:bg-gray-50"}`}
            >
              <div className="flex items-start gap-2">
                <span className="text-base shrink-0 mt-0.5">{asset.isImage ? "🖼" : "🎬"}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-gray-800 truncate" title={asset.filename}>{asset.filename}</p>
                  <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                    <span className="text-xs text-gray-400">{new Date(asset.uploadedAt).toLocaleDateString("zh-CN")}</span>
                    {asset.size && <span className="text-xs text-gray-400">{formatFileSize(asset.size)}</span>}
                    {proj && <span className="text-xs px-1 py-0.5 bg-blue-50 text-blue-600 rounded">{proj.name}</span>}
                  </div>
                  {asset.remark && <p className="text-xs text-gray-400 mt-0.5 truncate">{asset.remark}</p>}
                </div>
              </div>
              {isSelected && (
                <div className="flex gap-1 mt-1.5 ml-6" onClick={e => e.stopPropagation()}>
                  <button
                    onClick={() => onRename(asset)}
                    className="text-xs px-2 py-0.5 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded"
                  >
                    重命名
                  </button>
                  {confirmDeleteId === asset.id ? (
                    <div className="flex gap-1">
                      <button
                        onClick={() => { onDelete(asset); setConfirmDeleteId(null); }}
                        className="text-xs px-2 py-0.5 bg-red-500 text-white rounded hover:bg-red-600"
                      >确认</button>
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        className="text-xs px-2 py-0.5 bg-gray-200 text-gray-600 rounded"
                      >取消</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteId(asset.id)}
                      className="text-xs px-2 py-0.5 bg-gray-100 hover:bg-red-50 hover:text-red-500 text-gray-500 rounded"
                    >
                      删除
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- Asset Detail Panel (right panel) ---
function AssetDetailPanel({ asset, upload, analysis, prompt, history, activeHistoryIdx, onAnalyze, onPromptChange, onQuickTag, onResetPrompt, onSelectHistoryTab }) {
  if (!asset) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400 gap-3">
        <div className="text-6xl">🗂</div>
        <p className="text-sm">从左侧选择资产以查看详情或进行 AI 分析</p>
      </div>
    );
  }

  const isStreaming = analysis.status === "streaming";
  const canAnalyze = upload.phase === "done" && upload.signedPlayUrl && prompt.text.trim() !== "" && analysis.status !== "streaming";

  return (
    <div className="flex flex-col gap-4 p-4 overflow-y-auto h-full">
      {/* Media preview */}
      {upload.phase === "done" && upload.signedPlayUrl ? (
        asset.isImage ? (
          <ImagePreview src={upload.signedPlayUrl} filename={asset.filename} />
        ) : (
          <VideoPlayer src={upload.signedPlayUrl} filename={asset.filename} fileSize={asset.size} onError={() => {}} />
        )
      ) : upload.phase === "done" && !upload.signedPlayUrl ? (
        <div className="flex items-center justify-center bg-gray-100 rounded-xl text-gray-400 text-sm" style={{ aspectRatio: "16/9" }}>
          加载预览中…
        </div>
      ) : null}

      {/* Asset info */}
      <div className="flex items-center gap-2 flex-wrap text-xs text-gray-500">
        <span>{asset.isImage ? "🖼 图片" : "🎬 视频"}</span>
        {asset.size && <span>{formatFileSize(asset.size)}</span>}
        {asset.duration && <span>{Math.floor(asset.duration / 60)}:{String(Math.floor(asset.duration % 60)).padStart(2, "0")}</span>}
        {asset.width && asset.height && <span>{asset.width}×{asset.height}</span>}
        <span>{new Date(asset.uploadedAt).toLocaleString("zh-CN")}</span>
        {asset.remark && <span className="text-gray-400">• {asset.remark}</span>}
      </div>

      {/* Prompt editor */}
      <PromptEditor
        prompt={prompt}
        onPromptChange={onPromptChange}
        onQuickTag={onQuickTag}
        onReset={onResetPrompt}
      />

      {/* Analysis button */}
      <AnalysisButton
        status={analysis.status}
        onClick={onAnalyze}
        disabled={!canAnalyze}
      />

      {/* Analysis error / timeout */}
      {(analysis.status === "error" || analysis.status === "timeout") && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">
          ⚠️ {analysis.errorMessage}
        </div>
      )}

      {/* Results */}
      {(isStreaming || history.length > 0) && (
        <div>
          <h2 className="font-semibold text-gray-700 mb-3 flex items-center gap-2">📊 分析结果</h2>
          <ResultTabs results={history} activeIdx={activeHistoryIdx} onSelect={onSelectHistoryTab} />
          {isStreaming ? (
            <ResultCard result={null} streamBuffer={analysis.streamBuffer} isStreaming />
          ) : (
            <ResultCard result={history[activeHistoryIdx]} streamBuffer="" isStreaming={false} />
          )}
        </div>
      )}
    </div>
  );
}

// --- Asset Library Page (main container) ---
function AssetLibraryPage({ assetLibrary, upload, analysis, prompt, history, activeHistoryIdx, projectsList, onSelectAsset, onFilterProject, onFilterType, onSortOrder, onUploadClick, onDeleteAsset, onRenameAsset, onAnalyze, onPromptChange, onQuickTag, onResetPrompt, onSelectHistoryTab, queue, selectedProjectId, onSelectProject }) {
  const [renameTarget, setRenameTarget] = useState(null);

  const selectedAsset = assetLibrary.assets.find(a => a.id === assetLibrary.selectedAssetId) || null;
  const isStreaming = analysis.status === "streaming";
  const canAnalyze = upload.phase === "done" && upload.signedPlayUrl && prompt.text.trim() !== "" && analysis.status !== "streaming";

  async function handleRenameConfirm(filename, remark) {
    await onRenameAsset(renameTarget.id, filename, remark);
    setRenameTarget(null);
  }

  return (
    <div className="flex flex-1 overflow-hidden" style={{ minHeight: 0 }}>

      {/* ── 左栏 1/5：上传工具 + 进度 + 资产列表 ── */}
      <div className="w-1/5 shrink-0 flex flex-col border-r border-gray-200 bg-white overflow-hidden">
        {/* 上传工具区 */}
        <div className="px-3 py-2 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-xs font-semibold text-gray-600 shrink-0">资产库</span>
          </div>
          <div className="flex items-center gap-1.5">
            <select
              value={selectedProjectId || ""}
              onChange={e => onSelectProject(e.target.value || null)}
              className="flex-1 min-w-0 text-xs border border-gray-200 rounded px-1.5 py-1 bg-white text-gray-700 focus:outline-none"
              title="上传到项目"
            >
              <option value="">未分类</option>
              {projectsList.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button
              onClick={onUploadClick}
              className="shrink-0 text-xs px-2.5 py-1.5 bg-blue-700 text-white rounded-lg hover:bg-blue-800 font-medium"
            >
              + 上传
            </button>
          </div>
        </div>

        {/* 上传进度区 */}
        {queue && queue.items.length > 0 && (
          <div className="border-b border-gray-100 shrink-0 px-2 py-1.5">
            <QueuePanel items={queue.items} activeObjectKey={null} onClear={null} onSwitch={null} />
          </div>
        )}

        {/* 加载状态 */}
        {assetLibrary.status === "loading" && (
          <div className="flex items-center justify-center h-20 text-gray-400 text-xs gap-1.5 shrink-0">
            <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
            </svg>
            加载中…
          </div>
        )}

        {/* 资产列表 */}
        {assetLibrary.status !== "loading" && (
          <AssetList
            assets={assetLibrary.assets}
            selectedAssetId={assetLibrary.selectedAssetId}
            filterProjectId={assetLibrary.filterProjectId}
            filterType={assetLibrary.filterType}
            sortOrder={assetLibrary.sortOrder}
            projectsList={projectsList}
            onSelect={onSelectAsset}
            onFilterProject={onFilterProject}
            onFilterType={onFilterType}
            onSortOrder={onSortOrder}
            onDelete={onDeleteAsset}
            onRename={asset => setRenameTarget(asset)}
          />
        )}
      </div>

      {/* ── 中栏 flex-1（~2/5）：视频播放器 + 提示词 + 分析按钮 ── */}
      <div className="flex-1 flex flex-col overflow-y-auto p-4 gap-3 border-r border-gray-200 bg-gray-50">
        {!selectedAsset ? (
          <div className="flex flex-col items-center justify-center flex-1 text-gray-400 gap-3">
            <div className="text-5xl">🎬</div>
            <p className="text-sm">从左侧选择资产</p>
          </div>
        ) : (
          <>
            {/* 视频/图片预览 */}
            {upload.phase === "done" && upload.signedPlayUrl ? (
              selectedAsset.isImage
                ? <ImagePreview src={upload.signedPlayUrl} filename={selectedAsset.filename} />
                : <VideoPlayer src={upload.signedPlayUrl} filename={selectedAsset.filename} fileSize={selectedAsset.size} onError={() => {}} />
            ) : (
              <div className="flex items-center justify-center bg-gray-200 rounded-xl text-gray-400 text-sm" style={{ aspectRatio: "16/9" }}>
                加载预览中…
              </div>
            )}

            {/* 资产信息 */}
            <div className="flex items-center gap-2 flex-wrap text-xs text-gray-500">
              <span>{selectedAsset.isImage ? "🖼 图片" : "🎬 视频"}</span>
              {selectedAsset.size > 0 && <span>{formatFileSize(selectedAsset.size)}</span>}
              {selectedAsset.duration && <span>{Math.floor(selectedAsset.duration / 60)}:{String(Math.floor(selectedAsset.duration % 60)).padStart(2, "0")}</span>}
              {selectedAsset.width && selectedAsset.height && <span>{selectedAsset.width}×{selectedAsset.height}</span>}
              <span>{new Date(selectedAsset.uploadedAt).toLocaleString("zh-CN")}</span>
            </div>

            {/* 提示词 */}
            <PromptEditor prompt={prompt} onPromptChange={onPromptChange} onQuickTag={onQuickTag} onReset={onResetPrompt} />

            {/* 分析按钮 */}
            <AnalysisButton status={analysis.status} onClick={onAnalyze} disabled={!canAnalyze} />

            {/* 错误提示 */}
            {(analysis.status === "error" || analysis.status === "timeout") && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">
                ⚠️ {analysis.errorMessage}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── 右栏 2/5：AI 分析结果 ── */}
      <div className="w-2/5 shrink-0 flex flex-col overflow-y-auto p-4 bg-white">
        {!selectedAsset ? (
          <div className="flex flex-col items-center justify-center flex-1 text-gray-400 gap-3">
            <div className="text-5xl">📊</div>
            <p className="text-sm">选择资产后可进行 AI 分析</p>
          </div>
        ) : !(isStreaming || history.length > 0) ? (
          <div className="flex flex-col items-center justify-center flex-1 text-gray-400 gap-2">
            <div className="text-4xl">💡</div>
            <p className="text-sm">点击「开始视频分析」获取 AI 洞察</p>
          </div>
        ) : (
          <>
            <h2 className="font-semibold text-gray-700 mb-3 text-sm flex items-center gap-2">📊 分析结果</h2>
            <ResultTabs results={history} activeIdx={activeHistoryIdx} onSelect={onSelectHistoryTab} />
            {isStreaming
              ? <ResultCard result={null} streamBuffer={analysis.streamBuffer} isStreaming />
              : <ResultCard result={history[activeHistoryIdx]} streamBuffer="" isStreaming={false} />
            }
          </>
        )}
      </div>

      {/* Rename Modal */}
      {renameTarget && (
        <AssetRenameModal
          asset={renameTarget}
          onSave={handleRenameConfirm}
          onCancel={() => setRenameTarget(null)}
        />
      )}
    </div>
  );
}

// ===== SECTION 7: MAIN APP COMPONENT =====

export default function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const abortControllerRef = useRef(null);
  const timeoutHandleRef = useRef(null);
  const uploadInputRef = useRef(null);
  const { upload: ossUpload } = useOSSUpload();
  const { analyze: qwenAnalyze } = useQwenAnalysis();
  const { persistEntry, loadHistory, deleteEntry } = useOSSPersistence();

  const isConfigured = Object.values(state.config).every((v) => v.trim() !== "");
  const canAnalyze =
    state.upload.phase === "done" &&
    state.upload.signedPlayUrl &&
    state.prompt.text.trim() !== "" &&
    state.analysis.status !== "streaming";

  // 启动时从 OSS 加载项目列表、历史记录、资产清单
  useEffect(() => {
    if (!isConfigured) return;
    dispatch({ type: "PROJECTS_LOADING" });
    dispatch({ type: "ASSET_LIBRARY_LOADING" });
    dispatch({ type: "QWEN_CONN_CHECKING" });
    // 并行：OSS 加载 + Qwen 连通性检测
    fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/models", {
      headers: { Authorization: `Bearer ${state.config.qwenApiKey}` },
    })
      .then(r => dispatch({ type: r.ok ? "QWEN_CONN_OK" : "QWEN_CONN_ERROR" }))
      .catch(() => dispatch({ type: "QWEN_CONN_ERROR" }));
    loadProjectsFromOSS(state.config)
      .then(list => {
        dispatch({ type: "PROJECTS_LOADED", payload: { list } });
        // 并行加载：历史记录 + 资产清单
        return Promise.all([
          loadHistory(state.config, list, dispatch),
          loadAllProjectManifests(state.config, list)
            .then(assets => dispatch({ type: "ASSET_LIBRARY_LOADED", payload: { assets } }))
            .catch(err => dispatch({ type: "ASSET_LIBRARY_ERROR", payload: { message: err.message } })),
        ]);
      })
      .catch(() => {
        dispatch({ type: "PROJECTS_ERROR", payload: { message: "项目加载失败" } });
        dispatch({ type: "ASSET_LIBRARY_LOADED", payload: { assets: [] } });
        loadHistory(state.config, [], dispatch);
      });
  }, []);

  // 上传完成后写入资产清单并跳转资产库
  const handleItemDone = useCallback(async (queueItem, signedPlayUrl) => {
    const asset = {
      id: crypto.randomUUID(),
      objectKey: queueItem.objectKey,
      filename: queueItem.file?.name || queueItem.objectKey.split("/").pop(),
      remark: "",
      isImage: queueItem.isImage ?? false,
      size: queueItem.meta?.size || 0,
      duration: queueItem.meta?.duration || null,
      width: queueItem.meta?.width || null,
      height: queueItem.meta?.height || null,
      uploadedAt: new Date().toISOString(),
      projectId: queueItem.projectId || null,
    };
    // 写入 OSS manifest（fire-and-forget）
    saveAssetManifest(state.config, asset.projectId, [
      asset,
      ...(await loadAssetManifest(state.config, asset.projectId)),
    ]).catch(() => {});
    dispatch({ type: "ASSET_LIBRARY_ASSET_ADDED", payload: { asset } });
    dispatch({ type: "NAVIGATE_TO_LIBRARY" });
  }, [state.config]);

  // 队列处理器
  useQueueProcessor(state, dispatch, handleItemDone);

  // persistError 自动清除
  useEffect(() => {
    if (state.persistError) {
      const t = setTimeout(() => dispatch({ type: "CLEAR_PERSIST_ERROR" }), 4000);
      return () => clearTimeout(t);
    }
  }, [state.persistError]);

  // --- Handlers ---

  function handleSaveConfig(newConfig) {
    dispatch({ type: "SET_CONFIG", payload: newConfig });
    dispatch({ type: "CLOSE_CONFIG_PANEL" });
  }

  async function handleFilesSelected(files) {
    const validItems = [];
    const errors = [];
    for (const file of files) {
      const ext = "." + file.name.split(".").pop().toLowerCase();
      if (!ALLOWED_TYPES.includes(file.type) && !ALLOWED_EXTS.includes(ext)) {
        errors.push(`${file.name}：格式不支持`);
        continue;
      }
      const isImage = IMAGE_MIME_TYPES.has(file.type) || ALLOWED_IMAGE_EXTS.has(ext);
      const sizeLimit = isImage ? MAX_IMAGE_SIZE : MAX_FILE_SIZE;
      const sizeLimitLabel = isImage ? "20MB" : "200MB";
      if (file.size > sizeLimit) {
        errors.push(`${file.name}：超过 ${sizeLimitLabel}`);
        continue;
      }
      const meta = isImage ? await probeImageFile(file) : await probeVideoFile(file);
      validItems.push({
        id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
        file,
        objectKey: buildOSSObjectKey(file.name, state.selectedProjectId),
        projectId: state.selectedProjectId,
        isImage,
        status: "waiting",
        progress: 0,
        errorMessage: "",
        meta: {
          duration: meta.duration,
          width: meta.width,
          height: meta.height,
          size: file.size,
          lastModified: file.lastModified,
        },
      });
    }
    if (validItems.length > 0) {
      dispatch({ type: "QUEUE_ADD", payload: { items: validItems } });
    }
    if (errors.length > 0) {
      dispatch({
        type: "UPLOAD_ERROR",
        payload: { errorCode: "E001", errorMessage: errors.join("；") },
      });
    }
  }

  async function handleSelectAsset(assetId) {
    dispatch({ type: "SELECT_ASSET", payload: assetId });
    const asset = state.assetLibrary.assets.find(a => a.id === assetId);
    if (!asset) return;
    try {
      const signedPlayUrl = await generateOSSPresignedUrl(state.config, asset.objectKey, "GET", 7200);
      dispatch({ type: "UPLOAD_DONE", payload: { signedPlayUrl } });
    } catch { /* leave signedPlayUrl null */ }
  }

  async function handleDeleteAsset(asset) {
    try {
      await deleteOSSObject(state.config, asset.objectKey);
    } catch { /* log but continue */ }
    try {
      await patchAssetInManifest(state.config, asset.projectId, asset.id, null);
    } catch { /* log but continue */ }
    dispatch({ type: "ASSET_DELETED", payload: asset.id });
  }

  async function handleRenameAsset(assetId, filename, remark) {
    const asset = state.assetLibrary.assets.find(a => a.id === assetId);
    if (!asset) return;
    await patchAssetInManifest(state.config, asset.projectId, assetId, { filename, remark });
    dispatch({ type: "ASSET_RENAMED", payload: { id: assetId, filename, remark } });
  }

  async function handleAnalyze() {
    if (!canAnalyze) return;

    let freshUrl = state.upload.signedPlayUrl;
    try {
      freshUrl = await generateOSSPresignedUrl(state.config, state.upload.objectKey, "GET", 7200);
    } catch { /* use existing url */ }

    const startedAt = Date.now();
    dispatch({ type: "ANALYSIS_START", payload: { startedAt } });

    const ac = new AbortController();
    abortControllerRef.current = ac;
    timeoutHandleRef.current = setTimeout(() => {
      ac.abort();
      dispatch({ type: "ANALYSIS_TIMEOUT" });
    }, ANALYSIS_TIMEOUT_MS);

    // trackingDispatch 捕获完整 streamBuffer（避免 stale closure）
    let localBuffer = "";
    const trackingDispatch = (action) => {
      if (action.type === "ANALYSIS_TOKEN") localBuffer += action.payload;
      dispatch(action);
    };

    try {
      await qwenAnalyze(state.config, freshUrl, state.prompt.text, trackingDispatch, ac.signal, state.upload.isImage);
      clearTimeout(timeoutHandleRef.current);
      const elapsedMs = Date.now() - startedAt;
      dispatch({ type: "ANALYSIS_DONE", payload: { elapsedMs } });

      // 持久化分析结果到 OSS（fire-and-forget）
      const entry = {
        id: `${Date.now()}`,
        timestamp: new Date(),
        promptUsed: state.prompt.text,
        resultText: localBuffer,
        elapsedMs,
        videoObjectKey: state.upload.objectKey,
        projectId: state.selectedProjectId,
        isImage: state.upload.isImage,
      };
      dispatch({ type: "OSS_HISTORY_ENTRY_ADDED", payload: { entry } });
      persistEntry(state.config, entry, dispatch);
    } catch (err) {
      clearTimeout(timeoutHandleRef.current);
      if (err.name !== "AbortError") {
        dispatch({ type: "ANALYSIS_ERROR", payload: { errorMessage: err.message } });
      }
    }
  }

  async function handleRestoreFromHistory(entry) {
    let signedPlayUrl = "";
    try {
      signedPlayUrl = await generateOSSPresignedUrl(state.config, entry.videoObjectKey, "GET", 7200);
    } catch { /* restore text only */ }
    dispatch({ type: "RESTORE_FROM_HISTORY", payload: { entry, signedPlayUrl } });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function handleDeleteHistoryEntry(entry) {
    await deleteEntry(state.config, entry, dispatch);
  }

  function handlePromptChange(text) {
    if (text.length <= MAX_PROMPT_CHARS) {
      dispatch({ type: "SET_PROMPT", payload: text });
    }
  }

  function handleQuickTag(appendText) {
    const newText = state.prompt.text + appendText;
    if (newText.length <= MAX_PROMPT_CHARS) {
      dispatch({ type: "SET_PROMPT", payload: newText });
    }
  }

  function handleVideoError() {
    // E004: signed URL expired or network issue
  }

  // --- Render ---
  const { upload, prompt, analysis, history, activeHistoryIdx, queue } = state;
  const isStreaming = analysis.status === "streaming";
  const uploadErrorMsg =
    upload.phase === "error" || upload.errorCode ? upload.errorMessage : null;

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col font-sans">
      {/* Header */}
      <header className="bg-blue-800 text-white px-5 py-3 flex items-center justify-between shadow">
        <h1 className="text-base font-semibold tracking-wide">
          🏗 安居集团工程视频资产AI-Insight智能体（v3.0）
        </h1>
        <div className="flex items-center gap-4">
          {isConfigured && (
            <div className="hidden sm:flex items-center gap-3 text-xs text-blue-200">
              <span title={getQwenStatusDot(state.qwenConnStatus).title} className="flex items-center gap-1">
                🤖 qwen-vl-plus
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: getQwenStatusDot(state.qwenConnStatus).color, display: "inline-block", flexShrink: 0 }} />
              </span>
              <span className="text-blue-500">|</span>
              <span title={getOssStatusDot(state.ossHistory.status).title} className="flex items-center gap-1 max-w-[180px]">
                <span className="truncate">🗄 {state.config.ossRegion}</span>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: getOssStatusDot(state.ossHistory.status).color, display: "inline-block", flexShrink: 0 }} />
              </span>
            </div>
          )}
          {isConfigured && (
            <button
              onClick={() => dispatch({ type: "NAVIGATE_TO_LIBRARY" })}
              title="资产库"
              className={`transition-colors text-lg ${state.currentPage === "library" ? "text-white" : "text-blue-200 hover:text-white"}`}
            >
              🗂
            </button>
          )}
          {isConfigured && (
            <button
              onClick={() => dispatch({ type: "NAVIGATE_TO_PROJECTS" })}
              title="工程项目管理"
              className={`transition-colors text-lg ${state.currentPage === "projects" ? "text-white" : "text-blue-200 hover:text-white"}`}
            >
              📁
            </button>
          )}
          {isConfigured && (
            <button
              onClick={() => dispatch({ type: "TOGGLE_HISTORY_DRAWER" })}
              title="历史分析记录"
              className="text-blue-200 hover:text-white transition-colors text-lg"
            >
              📋
            </button>
          )}
          <button
            onClick={() => dispatch({ type: "TOGGLE_CONFIG_PANEL" })}
            title="系统配置"
            className="text-blue-200 hover:text-white transition-colors text-lg"
          >
            ⚙️
          </button>
        </div>
      </header>

      {/* persist error toast */}
      {state.persistError && (
        <div className="bg-orange-50 border-b border-orange-200 px-5 py-2 text-sm text-orange-700 flex justify-between">
          <span>⚠️ 分析结果保存失败：{state.persistError}</span>
          <button onClick={() => dispatch({ type: "CLEAR_PERSIST_ERROR" })} className="ml-4 font-bold">×</button>
        </div>
      )}

      {/* Config Panel */}
      {state.configPanelOpen && (
        <ConfigPanel
          config={state.config}
          onSave={handleSaveConfig}
          onToggle={() => dispatch({ type: "TOGGLE_CONFIG_PANEL" })}
        />
      )}

      {/* Hidden upload input for AssetLibraryPage */}
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        accept=".mp4,.mov,.avi,.jpg,.jpeg,.png,.webp,.gif,.bmp,video/mp4,video/quicktime,video/x-msvideo,image/jpeg,image/png,image/webp,image/gif,image/bmp"
        className="hidden"
        onChange={e => {
          const files = Array.from(e.target.files);
          if (files.length > 0) handleFilesSelected(files);
          e.target.value = "";
        }}
      />

      {/* Page Routing */}
      {state.currentPage === "projects" ? (
        <ProjectManagementPage
          projects={state.projects}
          ossHistory={state.ossHistory}
          config={state.config}
          onBack={() => dispatch({ type: "NAVIGATE_TO_LIBRARY" })}
          onProjectAdded={(project) => dispatch({ type: "PROJECT_ADDED", payload: project })}
          onProjectUpdated={(project) => dispatch({ type: "PROJECT_UPDATED", payload: project })}
          onProjectDeleted={(projectId) => dispatch({ type: "PROJECT_DELETED", payload: projectId })}
          onViewHistory={(projectId) => dispatch({ type: "OPEN_HISTORY_DRAWER_FOR_PROJECT", payload: projectId })}
        />
      ) : state.currentPage === "library" ? (
        <AssetLibraryPage
          assetLibrary={state.assetLibrary}
          upload={upload}
          analysis={analysis}
          prompt={prompt}
          history={history}
          activeHistoryIdx={activeHistoryIdx}
          projectsList={state.projects.list}
          onSelectAsset={handleSelectAsset}
          onFilterProject={(id) => dispatch({ type: "SET_ASSET_FILTER_PROJECT", payload: id })}
          onFilterType={(t) => dispatch({ type: "SET_ASSET_FILTER_TYPE", payload: t })}
          onSortOrder={(o) => dispatch({ type: "SET_ASSET_SORT_ORDER", payload: o })}
          onUploadClick={() => uploadInputRef.current?.click()}
          onDeleteAsset={handleDeleteAsset}
          onRenameAsset={handleRenameAsset}
          onAnalyze={handleAnalyze}
          onPromptChange={handlePromptChange}
          onQuickTag={handleQuickTag}
          onResetPrompt={() => dispatch({ type: "RESET_PROMPT" })}
          onSelectHistoryTab={(i) => dispatch({ type: "SELECT_HISTORY_TAB", payload: i })}
          queue={queue}
          selectedProjectId={state.selectedProjectId}
          onSelectProject={(id) => dispatch({ type: "SET_SELECTED_PROJECT", payload: id })}
        />
      ) : (
        /* Legacy Analysis Page — RESTORE_FROM_HISTORY 仍跳转此页 */
        <main
          className={`flex-1 p-4 transition-opacity ${!isConfigured && !state.configPanelOpen ? "opacity-40 pointer-events-none" : ""}`}
        >
          <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Left: Video area */}
            <div className="lg:col-span-2 flex flex-col gap-3">
              {upload.phase === "done" ? (
                upload.isImage ? (
                  <ImagePreview src={upload.signedPlayUrl} filename={upload.file?.name} />
                ) : (
                  <VideoPlayer
                    src={upload.signedPlayUrl}
                    filename={upload.file?.name}
                    fileSize={upload.file?.size}
                    onError={handleVideoError}
                  />
                )
              ) : (
                <UploadZone
                  onFilesSelected={handleFilesSelected}
                  uploadError={uploadErrorMsg}
                  onClearError={() => dispatch({ type: "RESET_UPLOAD" })}
                />
              )}
              {upload.phase !== "uploading" && (
                <ProjectSelector
                  projectsList={state.projects.list}
                  selectedProjectId={state.selectedProjectId}
                  onSelect={(id) => dispatch({ type: "SET_SELECTED_PROJECT", payload: id })}
                  onCreateNew={() => dispatch({ type: "NAVIGATE_TO_PROJECTS" })}
                />
              )}
              {upload.phase === "uploading" && (
                <UploadProgress
                  progress={upload.progress}
                  filename={upload.file?.name}
                  fileSize={upload.file?.size}
                />
              )}
              {queue.items.length > 0 && (
                <QueuePanel
                  items={queue.items}
                  activeObjectKey={upload.objectKey}
                  onClear={() => dispatch({ type: "QUEUE_CLEAR" })}
                  onSwitch={(item) => dispatch({ type: "SWITCH_TO_QUEUE_ITEM", payload: { item } })}
                />
              )}
              {upload.phase === "done" && (
                <button
                  onClick={() => dispatch({ type: "NAVIGATE_TO_LIBRARY" })}
                  className="text-sm text-gray-400 hover:text-gray-600 underline self-start"
                >
                  返回资产库
                </button>
              )}
            </div>

            {/* Right: Prompt + Analysis button */}
            <div className="flex flex-col gap-3">
              <PromptEditor
                prompt={prompt}
                onPromptChange={handlePromptChange}
                onQuickTag={handleQuickTag}
                onReset={() => dispatch({ type: "RESET_PROMPT" })}
              />

              <AnalysisButton
                status={analysis.status}
                onClick={handleAnalyze}
                disabled={!canAnalyze}
              />

              {(analysis.status === "error" || analysis.status === "timeout") && (
                <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">
                  ⚠️ {analysis.errorMessage}
                </div>
              )}
            </div>
          </div>

          {/* Results section */}
          {(isStreaming || history.length > 0) && (
            <div className="max-w-6xl mx-auto mt-5">
              <h2 className="font-semibold text-gray-700 mb-3 flex items-center gap-2">
                📊 分析结果
              </h2>
              <ResultTabs
                results={history}
                activeIdx={activeHistoryIdx}
                onSelect={(i) => dispatch({ type: "SELECT_HISTORY_TAB", payload: i })}
              />
              {isStreaming ? (
                <ResultCard result={null} streamBuffer={analysis.streamBuffer} isStreaming />
              ) : (
                <ResultCard result={history[activeHistoryIdx]} streamBuffer="" isStreaming={false} />
              )}
            </div>
          )}
        </main>
      )}

      {/* History Drawer */}
      <HistoryDrawer
        open={state.historyDrawerOpen}
        ossHistory={state.ossHistory}
        projectsList={state.projects.list}
        filterProjectId={state.historyDrawerProjectFilter}
        onClose={() => dispatch({ type: "CLOSE_HISTORY_DRAWER" })}
        onRestore={handleRestoreFromHistory}
        onDelete={handleDeleteHistoryEntry}
      />
    </div>
  );
}

// Named exports for testing — 不改变任何运行时行为，仅让测试文件可以按名导入
export {
  // 纯工具函数（无副作用，最容易测）
  buildOSSObjectKey,
  formatElapsed,
  formatFileSize,
  parseInline,
  renderMarkdownLine,
  // 状态管理
  appReducer,
  initialState,
  // OSS 异步函数（需要 mock fetch）
  generateOSSPresignedUrl,
  saveAnalysisToOSS,
  updateOSSIndex,
  loadOSSHistory,
  loadAllOSSHistory,
  loadProjectsFromOSS,
  saveProjectsToOSS,
  // v3.0: 资产库工具函数
  loadAssetManifest,
  saveAssetManifest,
  deleteOSSObject,
  loadAllProjectManifests,
  patchAssetInManifest,
  // UI 组件
  UploadZone,
  QueuePanel,
  HistoryDrawer,
  ProjectSelector,
  AnalysisButton,
  ResultCard,
  MarkdownRenderer,
  ProjectManagementPage,
  // v3.0: 资产库组件
  AssetRenameModal,
  AssetList,
  AssetDetailPanel,
  AssetLibraryPage,
};

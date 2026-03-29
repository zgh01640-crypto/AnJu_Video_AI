// ===== SECTION 1: IMPORTS =====
import { useState, useReducer, useRef, useCallback, useEffect } from "react";

// ===== SECTION 2: CONSTANTS =====
const DEFAULT_PROMPT = "请分析工程视频，正在进行哪些专业施工，形象进度如何";
const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB
const ALLOWED_TYPES = ["video/mp4", "video/quicktime", "video/x-msvideo"];
const ALLOWED_EXTS = [".mp4", ".mov", ".avi"];
const ANALYSIS_TIMEOUT_MS = 120000;
const MAX_PROMPT_CHARS = 500;
const QWEN_ENDPOINT =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";

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

function buildOSSObjectKey(filename) {
  const date = new Date().toISOString().slice(0, 10);
  const ts = Date.now();
  const safeName = filename.replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]/g, "_");
  return `videos/${date}/${ts}_${safeName}`;
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
  const objectKey = `analysis/${entry.id}.json`;
  const putUrl = await generateOSSPresignedUrl(config, objectKey, "PUT", 3600, "application/json");
  const res = await fetch(putUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: blob,
  });
  if (!res.ok) throw new Error(`OSS PUT failed: ${res.status}`);
  return objectKey;
}

async function updateOSSIndex(config, analysisObjectKey, action = "add") {
  const indexKey = "analysis/index.json";
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

async function loadOSSHistory(config) {
  const indexKey = "analysis/index.json";
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
      return { ...data, timestamp: new Date(data.timestamp) };
    })
  );
  return results
    .filter(r => r.status === "fulfilled")
    .map(r => r.value)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

async function deleteOSSHistoryEntry(config, entry) {
  const objectKey = `analysis/${entry.id}.json`;
  await updateOSSIndex(config, objectKey, "remove");
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
  persistError: "",

  // v1.1: 多视频上传队列
  queue: {
    items: [],   // QueueItem[]
    activeId: null,
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

    // ===== v1.1: HISTORY DRAWER ACTIONS =====
    case "OSS_HISTORY_LOADING":
      return { ...state, ossHistory: { ...state.ossHistory, status: "loading" } };
    case "OSS_HISTORY_LOADED":
      return { ...state, ossHistory: { status: "loaded", entries: action.payload.entries, errorMessage: "" } };
    case "OSS_HISTORY_ERROR":
      return { ...state, ossHistory: { ...state.ossHistory, status: "error", errorMessage: action.payload.message } };
    case "TOGGLE_HISTORY_DRAWER":
      return { ...state, historyDrawerOpen: !state.historyDrawerOpen };
    case "CLOSE_HISTORY_DRAWER":
      return { ...state, historyDrawerOpen: false };
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
        upload: {
          phase: "done", file: null,
          objectKey: entry.videoObjectKey,
          signedPlayUrl,
          progress: 100, errorCode: null, errorMessage: "",
        },
        history: [entry],
        activeHistoryIdx: 0,
        historyDrawerOpen: false,
        analysis: { ...initialState.analysis },
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
            i.id === id ? { ...i, status: "done", progress: 100 } : i
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

    default:
      return state;
  }
}

// ===== SECTION 5: CUSTOM HOOKS =====

function useOSSPersistence() {
  const persistEntry = useCallback(async (config, entry, dispatch) => {
    try {
      const objectKey = await saveAnalysisToOSS(config, entry);
      await updateOSSIndex(config, objectKey, "add");
    } catch (err) {
      dispatch({ type: "OSS_SAVE_ERROR", payload: { message: err.message } });
    }
  }, []);

  const loadHistory = useCallback(async (config, dispatch) => {
    dispatch({ type: "OSS_HISTORY_LOADING" });
    try {
      const entries = await loadOSSHistory(config);
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

function useQueueProcessor(state, dispatch) {
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
    async (config, signedPlayUrl, promptText, dispatch, abortSignal) => {
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
                { type: "video_url", video_url: { url: signedPlayUrl } },
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
        <p className="text-gray-400 text-sm mt-1">支持 MP4、MOV、AVI，最大 200MB，可多选</p>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".mp4,.mov,.avi,video/mp4,video/quicktime,video/x-msvideo"
        onChange={handleChange}
        className="hidden"
      />
    </div>
  );
}

// --- Queue Panel ---
function QueuePanel({ items, onClear }) {
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
        <button onClick={onClear} className="text-xs text-gray-400 hover:text-gray-600">清空</button>
      </div>
      <div className="flex flex-col gap-2">
        {items.map(item => {
          const sc = statusConfig[item.status];
          return (
            <div key={item.id} className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-600 truncate max-w-[200px]">{item.file?.name}</span>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${sc.cls}`}>{sc.text}</span>
              </div>
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
function HistoryDrawer({ open, ossHistory, onClose, onRestore, onDelete }) {
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const grouped = {};
  (ossHistory.entries || []).forEach(entry => {
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
          <h2 className="font-semibold text-gray-800">📋 历史分析记录</h2>
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
          {(ossHistory.status === "loaded" || ossHistory.status === "idle") && ossHistory.entries.length === 0 && (
            <div className="text-gray-400 text-sm text-center mt-12">暂无历史记录</div>
          )}
          {Object.entries(grouped).map(([date, entries]) => (
            <div key={date} className="mb-4">
              <div className="text-xs font-medium text-gray-400 mb-2 px-1">{date}</div>
              {entries.map(entry => (
                <div key={entry.id} className="bg-gray-50 rounded-lg p-3 mb-2 border border-gray-100">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-400 mb-1">
                        {new Date(entry.timestamp).toLocaleTimeString("zh-CN")} · {formatElapsed(entry.elapsedMs)}
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

// ===== SECTION 7: MAIN APP COMPONENT =====

export default function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const abortControllerRef = useRef(null);
  const timeoutHandleRef = useRef(null);
  const { upload: ossUpload } = useOSSUpload();
  const { analyze: qwenAnalyze } = useQwenAnalysis();
  const { persistEntry, loadHistory, deleteEntry } = useOSSPersistence();

  const isConfigured = Object.values(state.config).every((v) => v.trim() !== "");
  const canAnalyze =
    state.upload.phase === "done" &&
    state.prompt.text.trim() !== "" &&
    state.analysis.status !== "streaming";

  // 启动时从 OSS 加载历史记录
  useEffect(() => {
    if (isConfigured) loadHistory(state.config, dispatch);
  }, []);

  // 队列处理器
  useQueueProcessor(state, dispatch);

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

  function handleFilesSelected(files) {
    const validItems = [];
    const errors = [];
    for (const file of files) {
      const ext = "." + file.name.split(".").pop().toLowerCase();
      if (!ALLOWED_TYPES.includes(file.type) && !ALLOWED_EXTS.includes(ext)) {
        errors.push(`${file.name}：格式不支持`);
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        errors.push(`${file.name}：超过 200MB`);
        continue;
      }
      validItems.push({
        id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
        file,
        objectKey: buildOSSObjectKey(file.name),
        status: "waiting",
        progress: 0,
        errorMessage: "",
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
      await qwenAnalyze(state.config, freshUrl, state.prompt.text, trackingDispatch, ac.signal);
      clearTimeout(timeoutHandleRef.current);
      const elapsedMs = Date.now() - startedAt;
      dispatch({ type: "ANALYSIS_DONE", payload: { elapsedMs } });

      // Feature 1: 持久化分析结果到 OSS（fire-and-forget）
      const entry = {
        id: `${Date.now()}`,
        timestamp: new Date(),
        promptUsed: state.prompt.text,
        resultText: localBuffer,
        elapsedMs,
        videoObjectKey: state.upload.objectKey,
      };
      // 立即更新本地历史列表，无需等待 OSS 写入
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
    // User should refresh the page
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
          🏗 安居集团 · 工程视频分析系统
        </h1>
        <div className="flex items-center gap-4">
          {isConfigured && (
            <div className="hidden sm:flex items-center gap-3 text-xs text-blue-200">
              <span title="AI 分析模型">🤖 qwen-vl-plus</span>
              <span className="text-blue-500">|</span>
              <span title="OSS 存储" className="max-w-[180px] truncate">🗄 {state.config.ossRegion}</span>
            </div>
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

      {/* Main Content */}
      <main
        className={`flex-1 p-4 transition-opacity ${!isConfigured && !state.configPanelOpen ? "opacity-40 pointer-events-none" : ""}`}
      >
        <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Left: Video area */}
          <div className="lg:col-span-2 flex flex-col gap-3">
            {upload.phase === "done" ? (
              <VideoPlayer
                src={upload.signedPlayUrl}
                filename={upload.file?.name}
                fileSize={upload.file?.size}
                onError={handleVideoError}
              />
            ) : (
              <UploadZone
                onFilesSelected={handleFilesSelected}
                uploadError={uploadErrorMsg}
                onClearError={() => dispatch({ type: "RESET_UPLOAD" })}
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
                onClear={() => dispatch({ type: "QUEUE_CLEAR" })}
              />
            )}
            {upload.phase === "done" && (
              <button
                onClick={() => dispatch({ type: "RESET_UPLOAD" })}
                className="text-sm text-gray-400 hover:text-gray-600 underline self-start"
              >
                重新上传视频
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

            {/* Analysis error / timeout inline feedback */}
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
              <ResultCard
                result={null}
                streamBuffer={analysis.streamBuffer}
                isStreaming
              />
            ) : (
              <ResultCard
                result={history[activeHistoryIdx]}
                streamBuffer=""
                isStreaming={false}
              />
            )}
          </div>
        )}
      </main>

      {/* History Drawer */}
      <HistoryDrawer
        open={state.historyDrawerOpen}
        ossHistory={state.ossHistory}
        onClose={() => dispatch({ type: "CLOSE_HISTORY_DRAWER" })}
        onRestore={handleRestoreFromHistory}
        onDelete={handleDeleteHistoryEntry}
      />
    </div>
  );
}

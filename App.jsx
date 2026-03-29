// ===== SECTION 1: IMPORTS =====
import { useState, useReducer, useRef, useCallback } from "react";

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

    default:
      return state;
  }
}

// ===== SECTION 5: CUSTOM HOOKS =====

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
function UploadZone({ onFileSelected, uploadError, onClearError }) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) onFileSelected(file);
  }

  function handleChange(e) {
    const file = e.target.files[0];
    if (file) onFileSelected(file);
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
        <p className="text-gray-400 text-sm mt-1">支持 MP4、MOV、AVI，最大 200MB</p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".mp4,.mov,.avi,video/mp4,video/quicktime,video/x-msvideo"
        onChange={handleChange}
        className="hidden"
      />
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

  const isConfigured = Object.values(state.config).every((v) => v.trim() !== "");
  const canAnalyze =
    state.upload.phase === "done" &&
    state.prompt.text.trim() !== "" &&
    state.analysis.status !== "streaming";

  // --- Handlers ---

  function handleSaveConfig(newConfig) {
    dispatch({ type: "SET_CONFIG", payload: newConfig });
    dispatch({ type: "CLOSE_CONFIG_PANEL" });
  }

  function handleFileSelected(file) {
    // Validate type
    const ext = "." + file.name.split(".").pop().toLowerCase();
    if (!ALLOWED_TYPES.includes(file.type) && !ALLOWED_EXTS.includes(ext)) {
      dispatch({
        type: "UPLOAD_ERROR",
        payload: {
          errorCode: "E001",
          errorMessage: "仅支持 MP4、MOV、AVI 格式，请重新选择",
        },
      });
      return;
    }
    // Validate size
    if (file.size > MAX_FILE_SIZE) {
      dispatch({
        type: "UPLOAD_ERROR",
        payload: {
          errorCode: "E002",
          errorMessage: "文件大小超出限制（最大 200MB），请压缩后重新上传",
        },
      });
      return;
    }

    const objectKey = buildOSSObjectKey(file.name);
    dispatch({ type: "FILE_SELECTED", payload: { file, objectKey } });

    // Start upload
    ossUpload(state.config, file, objectKey, dispatch)
      .then(async () => {
        const signedPlayUrl = await generateOSSPresignedUrl(
          state.config,
          objectKey,
          "GET",
          7200
        );
        dispatch({ type: "UPLOAD_DONE", payload: { signedPlayUrl } });
      })
      .catch((err) => {
        const isCors = err.message === "CORS_ERROR";
        dispatch({
          type: "UPLOAD_ERROR",
          payload: {
            errorCode: "E003",
            errorMessage: isCors
              ? "上传失败：OSS 跨域（CORS）未配置，请联系管理员参考 SETUP.md 配置"
              : `上传失败：${err.message}`,
          },
        });
      });
  }

  async function handleAnalyze() {
    if (!canAnalyze) return;

    // Refresh the signed play URL before sending to Qwen
    let freshUrl = state.upload.signedPlayUrl;
    try {
      freshUrl = await generateOSSPresignedUrl(
        state.config,
        state.upload.objectKey,
        "GET",
        7200
      );
    } catch {
      // Use existing URL if refresh fails
    }

    const startedAt = Date.now();
    dispatch({ type: "ANALYSIS_START", payload: { startedAt } });

    const ac = new AbortController();
    abortControllerRef.current = ac;

    timeoutHandleRef.current = setTimeout(() => {
      ac.abort();
      dispatch({ type: "ANALYSIS_TIMEOUT" });
    }, ANALYSIS_TIMEOUT_MS);

    try {
      await qwenAnalyze(
        state.config,
        freshUrl,
        state.prompt.text,
        dispatch,
        ac.signal
      );
      clearTimeout(timeoutHandleRef.current);
      dispatch({
        type: "ANALYSIS_DONE",
        payload: { elapsedMs: Date.now() - startedAt },
      });
    } catch (err) {
      clearTimeout(timeoutHandleRef.current);
      if (err.name !== "AbortError") {
        dispatch({
          type: "ANALYSIS_ERROR",
          payload: { errorMessage: err.message },
        });
      }
    }
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
  const { upload, prompt, analysis, history, activeHistoryIdx } = state;
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
              <span title="OSS 存储"
                className="max-w-[180px] truncate"
              >🗄 {state.config.ossBucket} · {state.config.ossRegion}</span>
            </div>
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
                onFileSelected={handleFileSelected}
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
    </div>
  );
}

// 配置加载：所有可调参数集中于此，代码其他地方一律引用这里产出的对象，不许硬编码
// （AGENTS.md 配置纪律 / ground-truth.md 第四节）。

import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULTS = {
  port: 3000,
  dataPath: "./data", // 目录：store 按集合分文件存放于此（见 src/store/store.js）
  sse: {
    bufferSize: 2000,
    pingIntervalMs: 25000,
  },
  store: {
    debounceMs: 200,
  },
  // 多气泡规则（api-contract.md）：按段落边界切分流式回复。
  bubbles: {
    boundaryPattern: "\\n\\s*\\n",
    minLength: 1,
    maxLength: 800,
  },
  activity: {
    detailMaxLength: 2000,
  },
  mock: {
    delayMs: 30,
  },
  opencode: {
    binary: "/Users/theta/.opencode/bin/opencode",
    daemonPort: 0, // 0 = 每次启动随机挑空闲端口
    idleShutdownMs: 5 * 60 * 1000, // 无在飞 run 后多久回收 daemon
    watchdogMs: 30 * 60 * 1000, // 单次 run 看门狗（adapter-interface.md 行为规则）
    digestTimeoutMs: 5 * 60 * 1000,
    memoryDigestPrimaryModel: "navy/deepseek-v4-pro",
    memoryDigestQuotaFallbackModel: "opencode/deepseek-v4-flash-free",
  },
  codex: {
    binary: "codex",
    chatSandbox: "workspace-write",
    watchdogMs: 30 * 60 * 1000,
    digestTimeoutMs: 5 * 60 * 1000,
    maxInputBytes: 12000,
  },
  ollama: {
    watchdogMs: 30 * 60 * 1000,
    digestTimeoutMs: 5 * 60 * 1000,
    numCtx: 16384,
    maxInputBytes: 12000,
  },
  memory: {
    vaultPath: "~/.vera/memory", // Obsidian 兼容 vault，仓库外（api-contract.md Memory 一节）
    residentIndexMaxLines: 25, // 常驻索引截断行数
    digestRealtimeThresholdChars: 16000,
  },
  // Appearance 默认值（ground truth 4.3「F0确认默认值」/ api-contract.md Appearance 字段）。
  // 这是唯一默认源——settings-store 的 appearance.* deriveDefaults 从这里读，
  // 代码其他地方不许另写第二份。运行时覆盖走 PATCH /api/settings。
  // 主题/主题色/高亮色/字体族全局；字号/窗口边距按 phone/desktop × chat/management 分域；
  // 气泡圆角/间距按 phone/desktop 分域且只进聊天时间线。
  appearance: {
    theme: "system", // system / light / dark / custom
    themeId: null, // theme: custom 时指向已保存 Theme id
    themeColor: "", // 空 = 跟随 Theme Palette / 系统默认
    accentColor: "", // 同上
    fontFamily: "system", // system / 具体字体族字符串
    fontSize: {
      phone: { chat: 14, management: 14 },
      desktop: { chat: 16, management: 16 },
    },
    bubbleRadius: { phone: 16, desktop: 16 },
    bubbleGap: { phone: 4, desktop: 10 },
    windowMargin: {
      phone: { chat: 12, management: 12 },
      desktop: { chat: 64, management: 8 },
    },
  },
  // Speaker view 编译层（ground truth 2.3 / api-contract.md「Speaker view 编译层输出契约」）：
  // 群聊声告段从 messages.json 临时派生，每轮刷新、无状态。下列参数硬性约束段上限与署名呈现。
  viewCompiler: {
    groupDeltaMaxMessages: 20, // 单次声告段最大条数（超出从最早开始截断）
    groupDeltaMaxChars: 4000, // 单次声告段累计字符上限（同上）
    groupDeltaHeader: "=== 群内最近发言 ===",
    groupDeltaUserLabel: "用户",
    groupDeltaOmittedHint: "（更早的发言数量已达上限，可用 fetch_detail 主动调阅）",
  },
  agentDaemon: {
    heartbeatIntervalMs: 15000, // gateway 在 agent SSE 通道上发 agent.heartbeat 的间隔
    tokensPath: "~/.vera/agent-tokens.json", // agent token 文件（身份层 token，{ "agt_xxx": "<long-random>" }）
    sessionTimeoutMs: 45000, // daemon 多久没心跳 gateway 把 Account.presence 置 offline
  },
};

function num(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveInt(value, fallback) {
  const parsed = num(value, fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// `~` 前缀展开为用户主目录，其余路径原样返回（config 唯一负责展开的地方，
// 其余模块只拿到已展开的绝对/相对路径）。
function expandHome(path) {
  if (typeof path === "string" && path.startsWith("~")) {
    return join(homedir(), path.slice(1));
  }
  return path;
}

export function loadConfig(env = process.env) {
  const opencodeDigestPrimaryModel = env.VERA_OPENCODE_MEMORY_DIGEST_PRIMARY_MODEL || DEFAULTS.opencode.memoryDigestPrimaryModel;
  const opencodeDigestFallbackModel = env.VERA_OPENCODE_MEMORY_DIGEST_QUOTA_FALLBACK_MODEL || DEFAULTS.opencode.memoryDigestQuotaFallbackModel;
  return {
    port: num(env.PORT, DEFAULTS.port),
    dataPath: env.VERA_DATA_PATH || DEFAULTS.dataPath,
    sse: {
      bufferSize: num(env.VERA_SSE_BUFFER_SIZE, DEFAULTS.sse.bufferSize),
      pingIntervalMs: num(env.VERA_SSE_PING_INTERVAL_MS, DEFAULTS.sse.pingIntervalMs),
    },
    store: {
      debounceMs: num(env.VERA_STORE_DEBOUNCE_MS, DEFAULTS.store.debounceMs),
    },
    bubbles: {
      boundaryPattern: env.VERA_BUBBLE_BOUNDARY_PATTERN || DEFAULTS.bubbles.boundaryPattern,
      minLength: num(env.VERA_BUBBLE_MIN_LENGTH, DEFAULTS.bubbles.minLength),
      maxLength: num(env.VERA_BUBBLE_MAX_LENGTH, DEFAULTS.bubbles.maxLength),
    },
    activity: {
      detailMaxLength: num(env.VERA_ACTIVITY_DETAIL_MAX_LENGTH, DEFAULTS.activity.detailMaxLength),
    },
    mock: {
      delayMs: num(env.VERA_MOCK_DELAY_MS, DEFAULTS.mock.delayMs),
    },
    opencode: {
      binary: env.VERA_OPENCODE_BIN || DEFAULTS.opencode.binary,
      daemonPort: num(env.VERA_OPENCODE_DAEMON_PORT, DEFAULTS.opencode.daemonPort),
      idleShutdownMs: num(env.VERA_OPENCODE_IDLE_SHUTDOWN_MS, DEFAULTS.opencode.idleShutdownMs),
      watchdogMs: num(env.VERA_OPENCODE_WATCHDOG_MS, DEFAULTS.opencode.watchdogMs),
      digestTimeoutMs: num(env.VERA_OPENCODE_MEMORY_DIGEST_TIMEOUT_MS, DEFAULTS.opencode.digestTimeoutMs),
      memoryDigestQuotaFallbacks: opencodeDigestFallbackModel
        ? { [opencodeDigestPrimaryModel]: opencodeDigestFallbackModel }
        : {},
    },
    codex: {
      binary: env.VERA_CODEX_BIN || DEFAULTS.codex.binary,
      chatSandbox: ["read-only", "workspace-write"].includes(env.VERA_CODEX_CHAT_SANDBOX)
        ? env.VERA_CODEX_CHAT_SANDBOX
        : DEFAULTS.codex.chatSandbox,
      watchdogMs: positiveInt(env.VERA_CODEX_WATCHDOG_MS, DEFAULTS.codex.watchdogMs),
      digestTimeoutMs: positiveInt(
        env.VERA_CODEX_MEMORY_DIGEST_TIMEOUT_MS,
        DEFAULTS.codex.digestTimeoutMs,
      ),
      maxInputBytes: positiveInt(env.VERA_CODEX_MAX_INPUT_BYTES, DEFAULTS.codex.maxInputBytes),
    },
    ollama: {
      watchdogMs: positiveInt(env.VERA_OLLAMA_WATCHDOG_MS, DEFAULTS.ollama.watchdogMs),
      digestTimeoutMs: positiveInt(
        env.VERA_OLLAMA_MEMORY_DIGEST_TIMEOUT_MS,
        DEFAULTS.ollama.digestTimeoutMs,
      ),
      numCtx: positiveInt(env.VERA_OLLAMA_NUM_CTX, DEFAULTS.ollama.numCtx),
      maxInputBytes: positiveInt(env.VERA_OLLAMA_MAX_INPUT_BYTES, DEFAULTS.ollama.maxInputBytes),
    },
    memory: {
      vaultPath: expandHome(env.VERA_MEMORY_VAULT_PATH || DEFAULTS.memory.vaultPath),
      residentIndexMaxLines: num(env.VERA_MEMORY_INDEX_MAX_LINES, DEFAULTS.memory.residentIndexMaxLines),
      digestRealtimeThresholdChars: positiveInt(
        env.VERA_MEMORY_DIGEST_REALTIME_THRESHOLD_CHARS,
        DEFAULTS.memory.digestRealtimeThresholdChars,
      ),
    },
    appearance: DEFAULTS.appearance,
    viewCompiler: {
      groupDeltaMaxMessages: num(env.VERA_VIEW_COMPILER_GROUP_DELTA_MAX_MESSAGES, DEFAULTS.viewCompiler.groupDeltaMaxMessages),
      groupDeltaMaxChars: num(env.VERA_VIEW_COMPILER_GROUP_DELTA_MAX_CHARS, DEFAULTS.viewCompiler.groupDeltaMaxChars),
      groupDeltaHeader: env.VERA_VIEW_COMPILER_GROUP_DELTA_HEADER || DEFAULTS.viewCompiler.groupDeltaHeader,
      groupDeltaUserLabel: env.VERA_VIEW_COMPILER_GROUP_DELTA_USER_LABEL || DEFAULTS.viewCompiler.groupDeltaUserLabel,
      groupDeltaOmittedHint: env.VERA_VIEW_COMPILER_GROUP_DELTA_OMITTED_HINT || DEFAULTS.viewCompiler.groupDeltaOmittedHint,
    },
    agentDaemon: {
      heartbeatIntervalMs: num(env.VERA_AGENT_HEARTBEAT_INTERVAL_MS, DEFAULTS.agentDaemon.heartbeatIntervalMs),
      tokensPath: expandHome(env.VERA_AGENT_TOKENS_PATH || DEFAULTS.agentDaemon.tokensPath),
      sessionTimeoutMs: num(env.VERA_AGENT_SESSION_TIMEOUT_MS, DEFAULTS.agentDaemon.sessionTimeoutMs),
    },
  };
}

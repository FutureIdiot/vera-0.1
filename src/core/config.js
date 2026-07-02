// 配置加载：所有可调参数集中于此，代码其他地方一律引用这里产出的对象，不许硬编码
// （AGENTS.md 配置纪律 / ground-truth.md 第四节）。

const DEFAULTS = {
  port: 3000,
  dataPath: "./data/store.json",
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
};

function num(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env = process.env) {
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
  };
}

// mock adapter（docs/adapter-interface.md 示例 C）：回显文本，供 gateway 与
// 前端在无真实 CLI 时测试。
//
// - 内容带两个段落，配合 bubble-splitter 验证多气泡切分。
// - sessionState 存一个自增计数器 { count }，并把计数带进回复文本，用来验证
//   同一 (agent, Space) 连续对话时会话状态确实被 gateway 原样存取奉还。
// - 演示一条 phase:"tool" 的 activity，同一 callId 从 pending 原地更新到
//   completed，验证时间线的“同一条记录原地更新”规则。
// - 可注入延迟（chunkDelayMs，来自 core/config.js 的 mock.delayMs）与错误
//   （prompt.text 里带 "!!error" 触发 provider_error，方便手测/联调）。
// - prompt.text 里带 "!!approve" 时走一次 requestApproval，用于联调 Approval
//   卡片 -> answer endpoint 回填的整条链路，也让 timeline 能出现第三种
//   itemType。等待答复最多 approvalTimeoutMs；超时按未答复继续（approval 留在
//   pending，run 结束时由 gateway 标 expired 并 resolve "deny"）。

import { AdapterError } from "../core/errors.js";

function raceTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(Symbol.for("mock.approval.timeout")), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function delay(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new AdapterError("cancelled", "aborted during mock delay"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createMockAdapter({ chunkDelayMs = 30, approvalTimeoutMs = 15000 } = {}) {
  return {
    async run(ctx) {
      const { prompt, sessionState, onDelta, onActivity, requestApproval, signal } = ctx;

      if (signal?.aborted) {
        throw new AdapterError("cancelled", "aborted before start");
      }
      if (prompt.text.includes("!!error")) {
        throw new AdapterError("provider_error", "mock adapter induced provider_error");
      }

      const count = (sessionState?.count ?? 0) + 1;
      const paragraph1 = `回声第 ${count} 次：${prompt.text}`;
      const callId = "mock-bash-1";

      onActivity({ phase: "tool", label: "bash", detail: "npm test", toolStatus: "pending", callId });
      await delay(chunkDelayMs, signal);

      const half = Math.ceil(paragraph1.length / 2);
      onDelta(paragraph1.slice(0, half));
      await delay(chunkDelayMs, signal);
      onDelta(paragraph1.slice(half));
      await delay(chunkDelayMs, signal);

      onDelta("\n\n");
      onActivity({
        phase: "tool",
        label: "bash",
        detail: "npm test\n5 passed",
        toolStatus: "completed",
        callId,
      });
      await delay(chunkDelayMs, signal);

      let paragraph2 = `会话计数器已更新为 ${count}，可用于验证连续性。`;
      if (prompt.text.includes("!!approve")) {
        const answer = await raceTimeout(
          requestApproval({ prompt: "mock 请求执行 rm -rf ./dist，允许吗？", options: ["allow", "deny"] }),
          approvalTimeoutMs,
        );
        paragraph2 =
          answer === Symbol.for("mock.approval.timeout")
            ? `审批等待超时未答复。${paragraph2}`
            : `审批结果：${answer}。${paragraph2}`;
      }

      onDelta(paragraph2);

      if (signal?.aborted) {
        throw new AdapterError("cancelled", "aborted after streaming");
      }

      return { content: `${paragraph1}\n\n${paragraph2}`, sessionState: { count } };
    },
  };
}

// Speaker view 编译层（ground truth 2.3 / api-contract.md「Speaker view 编译层输出契约」）：
// 触发某 agent 的 run 时，从 store 临时派生 `ctx.prompt.text`——该 agent 上次本人发言
// 之后到当前触发之间的他人 Message 气泡，按时间穿插聚合成署名声告段，**不伪装一对一
// user 历史轮次**。Activity 永不进 prompt（ground truth 2.3 发言与过程边界）。
//
// 三条铁律：
//   1. 只 inject Message，Activity 永不进 prompt（包括本人）。
//   2. 群聊视角以署名声告段注入 ctx.prompt.text 头部，不伪装一对一 user 历史轮次。
//   3. 编译层无状态——每次 run 临时查 messages 派生 delta，幂等，不维护水位。
//
// 物理拼装顺序：[常驻索引块]?\n\n[群聊声告段]?\n\n[触发消息正文]
// 缺哪段哪段连同其后的空行一起省略；最终 text 永远至少含触发消息正文。
//
// 模块级无可变状态。同一输入两次产出同一 text。本模块不持有 hub / agentStates / 副作用依赖，
// 便于 Phase 5.5 把它从 run-controller 拆到 daemon prompt 路径。

function compareCreated(a, b) {
  // 同毫秒用 _seq 兜底：先按 createdAt 比较，平局按 _seq。
  const ta = Date.parse(a.createdAt ?? "");
  const tb = Date.parse(b.createdAt ?? "");
  if (ta === tb) {
    return (a._seq ?? 0) - (b._seq ?? 0);
  }
  return ta - tb;
}

// 找该 agent 最后一次本人发言气泡作为 marker。满足 author.type === "agent" &&
// author.agentId === agent.id 中 createdAt 最大者；同毫秒用 _seq 兜底。找不到返回 null。
function findLastOwnMarker(messages, agentId) {
  let marker = null;
  for (const m of messages) {
    if (m.author?.type !== "agent" || m.author?.agentId !== agentId) continue;
    if (marker === null || compareCreated(m, marker) > 0) {
      marker = m;
    }
  }
  return marker;
}

// 候选筛选：marker 之后（严格大于；同毫秒按 _seq）且 createdAt 严格小于触发消息（排除
// 触发自身）的他人气泡。排除该 agent 的自我气泡。Activity / Approval 不读，硬边界。
function pickCandidates({ messages, marker, agentId, triggerMessage }) {
  const candidates = [];
  for (const m of messages) {
    if (m.id === triggerMessage.id) continue; // 双保险，排除触发自身
    if (m.author?.type === "agent" && m.author?.agentId === agentId) continue; // 排除自我气泡
    if (marker) {
      const c = compareCreated(m, marker);
      if (c <= 0) continue; // 必须 > marker
    }
    // createdAt 严格 < trigger.createdAt
    const ct = compareCreated(m, triggerMessage);
    if (ct >= 0) continue;
    candidates.push(m);
  }
  candidates.sort((a, b) => compareCreated(a, b));
  return candidates;
}

// 从最末向前应用上限：累计 content 字符数 ≤ groupDeltaMaxChars 且条数 ≤
// groupDeltaMaxMessages，两条任一条命中即截断（截断的是最早那些）。返回保留下来的
// 候选（保持原 _seq 升序），以及是否发生截断。
function applyLimits({ candidates, maxMessages, maxChars }) {
  if (candidates.length === 0) return { kept: [], truncated: false };

  let keptReversed = [];
  let charSum = 0;
  let truncated = false;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const m = candidates[i];
    const len = typeof m.content === "string" ? m.content.length : 0;
    if (keptReversed.length + 1 > maxMessages) {
      truncated = true;
      break;
    }
    if (charSum + len > maxChars) {
      // 这条塞不下了：最早那些全截断
      if (i > 0) truncated = true;
      // 即便这条本身超 maxChars，也不放进来（保持段内单条不截断 content 的约定）
      break;
    }
    keptReversed.push(m);
    charSum += len;
  }
  keptReversed.reverse();
  return { kept: keptReversed, truncated };
}

function signatureFor({ m, agentId, store, userLabel }) {
  if (m.author?.type === "user") return userLabel;
  if (m.author?.type === "agent") {
    const agent = store.find("agents", m.author.agentId);
    return agent?.name ?? "agent";
  }
  return "agent";
}

function buildGroupDelta({ kept, truncated, config, store, agentId }) {
  if (kept.length === 0) return null;
  const header = config.viewCompiler.groupDeltaHeader;
  const userLabel = config.viewCompiler.groupDeltaUserLabel;
  const omittedHint = config.viewCompiler.groupDeltaOmittedHint;

  const lines = [];
  if (truncated) lines.push(omittedHint);
  for (const m of kept) {
    const sig = signatureFor({ m, agentId, store, userLabel });
    const content = typeof m.content === "string" ? m.content : "";
    lines.push(`- ${sig}: ${content}`);
  }
  return [header, ...lines].join("\n");
}

export async function compilePrompt({ store, space, agent, account, triggerMessage, memory, config }) {
  const priorSessionState = store.getSessionState(account.id, space.id);

  // 常驻索引块：仅 (account, Space) 尚无 sessionState（即将开启全新外部会话）时注入。
  // memory 空或 vault 空时 residentIndex 返回 null，直接照用。
  const residentBlock = priorSessionState === null ? await memory?.residentIndex() : null;

  // 群聊声告段：从 store 临时派生，幂等。
  const spaceMessages = store.list("messages").filter((m) => m.spaceId === space.id);
  const marker = findLastOwnMarker(spaceMessages, agent.id);
  const candidates = pickCandidates({ messages: spaceMessages, marker, agentId: agent.id, triggerMessage });
  const { kept, truncated } = applyLimits({
    candidates,
    maxMessages: config.viewCompiler.groupDeltaMaxMessages,
    maxChars: config.viewCompiler.groupDeltaMaxChars,
  });
  const groupDelta = buildGroupDelta({ kept, truncated, config, store, agentId: agent.id });

  // 拼装：[常驻索引块]?\n\n[群聊声告段]?\n\n[触发消息正文]
  // 缺哪段哪段连同其后的空行一起省略，不留前导/尾部空行。
  const parts = [];
  if (residentBlock) parts.push(residentBlock);
  if (groupDelta) parts.push(groupDelta);
  parts.push(triggerMessage.content ?? "");
  const text = parts.join("\n\n");

  return { text, sessionState: priorSessionState };
}

// AgentState（全局可见层，ground-truth.md 3.3 / api-contract.md）。
//
// F1 阶段：仍是 per-agent 单条记录（同一 agent 只有一条状态，currentSpaceId
// 指向它正在干活的 Space）。完整 per-Space 改造（同一 agent 在多个 Space 各有
// 独立记录）是 Phase 5.5.1。当前实现先满足 /api/agent-states 的 ?spaceId /
// ?agentId 过滤和契约输出形状（spaceId / detail 字段），不改跟踪模型。
//
// 判断记录：本轮任务的 src/store/ 持久化集合按主线程指令只列了
// agents/spaces/messages/activities/approvals/runs/sessionStates（不含
// agentStates），所以这里把 AgentState 实现为进程内存中的派生状态
// （不落盘），由 run 的开始/结束驱动更新，满足 /api/agent-states、
// /api/bootstrap 和 agent.state.updated 事件的契约形状。

export function createAgentStateTracker({ hub }) {
  const states = new Map(); // agentId -> AgentState

  function ensure(agentId) {
    if (!states.has(agentId)) {
      states.set(agentId, {
        agentId,
        status: "idle",
        spaceId: null,
        detail: "",
        lastActiveAt: null,
      });
    }
    return states.get(agentId);
  }

  function publish(agentId) {
    hub.publish("agent.state.updated", { agentState: states.get(agentId) });
  }

  function setWorking(agentId, spaceId) {
    const state = ensure(agentId);
    state.status = "working";
    state.spaceId = spaceId;
    state.lastActiveAt = new Date().toISOString();
    publish(agentId);
  }

  function setIdle(agentId) {
    const state = ensure(agentId);
    state.status = "idle";
    state.lastActiveAt = new Date().toISOString();
    publish(agentId);
  }

  function list({ spaceId, agentId } = {}) {
    let result = Array.from(states.values());
    if (spaceId) result = result.filter((s) => s.spaceId === spaceId);
    if (agentId) result = result.filter((s) => s.agentId === agentId);
    return result;
  }

  return { ensure, setWorking, setIdle, list };
}

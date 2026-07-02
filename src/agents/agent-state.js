// AgentState（全局可见层，ground-truth.md 3.3 / api-contract.md）。
//
// 判断记录：本轮任务的 src/store/ 持久化集合按主线程指令只列了
// agents/spaces/messages/activities/approvals/runs/sessionStates（不含
// agentStates），所以这里把 AgentState 实现为进程内存中的派生状态
// （不落盘），由 run 的开始/结束驱动更新，满足 /api/agent-states、
// /api/bootstrap 和 agent.state.updated 事件的契约形状。
// 这是本次实现里最拿不准的一处，需要主会话确认是否要落盘持久化。

export function createAgentStateTracker({ hub }) {
  const states = new Map(); // agentId -> AgentState

  function ensure(agentId) {
    if (!states.has(agentId)) {
      states.set(agentId, {
        agentId,
        status: "idle",
        currentSpaceId: null,
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
    state.currentSpaceId = spaceId;
    state.lastActiveAt = new Date().toISOString();
    publish(agentId);
  }

  function setIdle(agentId) {
    const state = ensure(agentId);
    state.status = "idle";
    state.lastActiveAt = new Date().toISOString();
    publish(agentId);
  }

  function list() {
    return Array.from(states.values());
  }

  return { ensure, setWorking, setIdle, list };
}

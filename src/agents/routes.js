// Agent HTTP 路由（api-contract.md 三、Agent 表格）。

import { asHandler, readJsonBody, sendJson, sendNoContent } from "../api/http.js";
import { listAgents, createAgent, updateAgent, deleteAgent } from "./agents.js";
import { listAccounts, createAccount, updateAccount, deleteAccount } from "./accounts.js";

export function registerAgentRoutes(router, { store, agentStates }) {
  router.get(
    "/api/agents",
    asHandler(async ({ res }) => {
      sendJson(res, 200, { agents: listAgents(store) });
    }),
  );

  router.post(
    "/api/agents",
    asHandler(async ({ req, res }) => {
      const body = await readJsonBody(req);
      const { agent, account } = createAgent(store, body);
      agentStates.ensure(agent.id);
      sendJson(res, 201, { agent, account });
    }),
  );

  router.patch(
    "/api/agents/:id",
    asHandler(async ({ req, res, params }) => {
      const body = await readJsonBody(req);
      const agent = updateAgent(store, params.id, body);
      sendJson(res, 200, { agent });
    }),
  );

  router.delete(
    "/api/agents/:id",
    asHandler(async ({ res, params }) => {
      deleteAgent(store, params.id);
      sendNoContent(res);
    }),
  );

  router.get(
    "/api/agent-states",
    asHandler(async ({ res, query }) => {
      const spaceId = query.get("spaceId") || undefined;
      const agentId = query.get("agentId") || undefined;
      sendJson(res, 200, { agentStates: agentStates.list({ spaceId, agentId }) });
    }),
  );

  router.get(
    "/api/accounts",
    asHandler(async ({ res, query }) => {
      sendJson(res, 200, { accounts: listAccounts(store, { agentId: query.get("agentId") || undefined }) });
    }),
  );

  router.post(
    "/api/agents/:id/accounts",
    asHandler(async ({ req, res, params }) => {
      const body = await readJsonBody(req);
      const account = createAccount(store, params.id, body);
      sendJson(res, 201, { account });
    }),
  );

  router.patch(
    "/api/accounts/:id",
    asHandler(async ({ req, res, params }) => {
      const body = await readJsonBody(req);
      const account = updateAccount(store, params.id, body);
      sendJson(res, 200, { account });
    }),
  );

  router.delete(
    "/api/accounts/:id",
    asHandler(async ({ res, params }) => {
      deleteAccount(store, params.id);
      sendNoContent(res);
    }),
  );
}

// Agent HTTP 路由（api-contract.md 三、Agent 表格）。

import { asHandler, readJsonBody, sendJson, sendNoContent } from "../api/http.js";
import { listAgents, createAgent, updateAgent, deleteAgent, projectAgent } from "./agents.js";
import {
  listAccounts,
  getAccountOrThrow,
  createAccount,
  createUnownedAccount,
  rotateAccountAccessKey,
  revokeAccountAccessKey,
  projectAccount,
  updateAccount,
  deleteAccount,
} from "./accounts.js";
import { listAccountLoginAudits, recordAccountLoginAudit } from "./login-audit.js";
import { listUnitBindings, updateUnitBinding } from "./unit-bindings.js";
import { accountModelOptions, updateAccountModel } from "./account-models.js";

export function registerAgentRoutes(router, {
  store,
  agentStates,
  memoryConfigService = null,
  controlService = null,
  daemonRuntime = null,
}) {
  if (controlService) {
    router.post(
      "/api/agent/enroll",
      asHandler(async ({ req, res }) => {
        const result = await controlService.enroll(await readJsonBody(req), req.headers);
        res.setHeader("Cache-Control", "no-store");
        sendJson(res, 201, result);
      }),
    );

    router.post(
      "/api/agent/login",
      asHandler(async ({ req, res }) => {
        const result = await controlService.login(await readJsonBody(req), req.headers);
        res.setHeader("Cache-Control", "no-store");
        sendJson(res, 200, result);
      }),
    );

    router.post(
      "/api/agent/workspace/register",
      asHandler(async ({ req, res }) => {
        sendJson(res, 200, await controlService.registerWorkspace(await readJsonBody(req), req.headers));
      }),
    );

    router.post(
      "/api/agent/workspace/authorize",
      asHandler(async ({ req, res }) => {
        sendJson(res, 200, await controlService.authorizeWorkspace(await readJsonBody(req), req.headers));
      }),
    );

    router.delete(
      "/api/agent/sessions/:accountId",
      asHandler(async ({ req, res, params }) => {
        await controlService.logout(params.accountId, req.headers);
        sendNoContent(res);
      }),
    );

    if (daemonRuntime) {
      router.get(
        "/api/agent/events",
        asHandler(async ({ req, res }) => {
          await daemonRuntime.openEvents(req, res);
        }),
      );

      router.post(
        "/api/agent/runs/:id/subagents",
        asHandler(async ({ req, res, params }) => {
          sendJson(res, 201, await daemonRuntime.createSubagent(params.id, await readJsonBody(req), req.headers));
        }),
      );

      router.patch(
        "/api/agent/runs/:id",
        asHandler(async ({ req, res, params }) => {
          sendJson(res, 200, await daemonRuntime.updateRun(params.id, await readJsonBody(req), req.headers));
        }),
      );

      router.post(
        "/api/agent/runs/:id/messages",
        asHandler(async ({ req, res, params }) => {
          sendJson(res, 201, await daemonRuntime.createMessage(params.id, await readJsonBody(req), req.headers));
        }),
      );

      router.post(
        "/api/agent/runs/:id/delta",
        asHandler(async ({ req, res, params }) => {
          sendJson(res, 200, await daemonRuntime.appendDelta(params.id, await readJsonBody(req), req.headers));
        }),
      );

      router.post(
        "/api/agent/runs/:id/activities",
        asHandler(async ({ req, res, params }) => {
          sendJson(res, 200, await daemonRuntime.upsertActivity(params.id, await readJsonBody(req), req.headers));
        }),
      );

      router.post(
        "/api/agent/runs/:id/approvals",
        asHandler(async ({ req, res, params }) => {
          sendJson(res, 201, await daemonRuntime.createApproval(params.id, await readJsonBody(req), req.headers));
        }),
      );

      router.put(
        "/api/agent/provider-bindings/:agentSessionId",
        asHandler(async ({ req, res, params }) => {
          sendJson(res, 200, await daemonRuntime.saveProviderBinding(
            params.agentSessionId, await readJsonBody(req), req.headers,
          ));
        }),
      );

      router.put(
        "/api/agent/runs/:id/api-result",
        asHandler(async ({ req, res, params }) => {
          sendJson(res, 200, await daemonRuntime.saveApiResult(params.id, await readJsonBody(req), req.headers));
        }),
      );

      router.put(
        "/api/agent/compactions/:jobId/targets/:agentId",
        asHandler(async ({ req, res, params }) => {
          sendJson(res, 200, await daemonRuntime.submitCompaction(
            params.jobId, params.agentId, await readJsonBody(req), req.headers,
          ));
        }),
      );
    }
  }

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
      memoryConfigService?.ensureAgentConfig(agent.id);
      sendJson(res, 201, { agent, account });
    }),
  );

  router.get(
    "/api/agents/:id/unit-bindings",
    asHandler(async ({ res, params, query }) => {
      sendJson(res, 200, { bindings: listUnitBindings(store, params.id, { kind: query.get("kind") }) });
    }),
  );

  router.patch(
    "/api/agents/:id/unit-bindings/:unitId",
    asHandler(async ({ req, res, params }) => {
      const body = await readJsonBody(req);
      const binding = updateUnitBinding(store, params.id, params.unitId, body);
      sendJson(res, 200, { binding });
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
      const accountId = query.get("accountId") || undefined;
      const agentId = query.get("agentId") || undefined;
      sendJson(res, 200, { agentStates: agentStates.list({ spaceId, accountId, agentId }) });
    }),
  );

  router.get(
    "/api/accounts",
    asHandler(async ({ res, query }) => {
      sendJson(res, 200, { accounts: listAccounts(store, {
        ownerAgentId: query.get("ownerAgentId") || query.get("agentId") || undefined,
        activeAgentId: query.get("activeAgentId") || undefined,
      }) });
    }),
  );

  router.post(
    "/api/accounts",
    asHandler(async ({ req, res }) => {
      const body = await readJsonBody(req);
      const result = createUnownedAccount(store, body);
      res.setHeader("Cache-Control", "no-store");
      sendJson(res, 201, result);
    }),
  );

  router.get(
    "/api/accounts/:id",
    asHandler(async ({ res, params }) => {
      const account = getAccountOrThrow(store, params.id);
      const owner = account.ownerAgentId ? store.find("agents", account.ownerAgentId) : null;
      const active = account.activeAgentId ? store.find("agents", account.activeAgentId) : null;
      sendJson(res, 200, {
        account,
        ownerAgent: owner ? projectAgent(owner) : null,
        activeAgent: active ? projectAgent(active) : null,
        modelOptions: accountModelOptions(store, account),
        recentLogins: listAccountLoginAudits(store, account.id, { limit: 20 }),
      });
    }),
  );

  router.post(
    "/api/accounts/:id/access-key/rotate",
    asHandler(async ({ res, params }) => {
      let result;
      if (controlService) result = await controlService.rotateAccessKey(params.id);
      else {
        result = rotateAccountAccessKey(store, params.id);
        const revokedAgentId = result.account.activeAgentId;
        store.update("accounts", params.id, {
          presence: "offline", activeAgentId: null, runtimeCapabilities: null,
          lastSeenAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        recordAccountLoginAudit(store, {
          accountId: params.id, agentId: revokedAgentId, event: "session_revoked",
          result: "succeeded", reasonCode: "access_key_rotated",
        });
        result.account = projectAccount(store.find("accounts", params.id));
      }
      res.setHeader("Cache-Control", "no-store");
      sendJson(res, 200, result);
    }),
  );

  router.delete(
    "/api/accounts/:id/access-key",
    asHandler(async ({ res, params }) => {
      if (controlService) sendJson(res, 200, await controlService.revokeAccessKey(params.id));
      else {
        const account = revokeAccountAccessKey(store, params.id);
        const revokedAgentId = account.activeAgentId;
        store.update("accounts", params.id, {
          presence: "offline", activeAgentId: null, runtimeCapabilities: null,
          lastSeenAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        recordAccountLoginAudit(store, {
          accountId: params.id, agentId: revokedAgentId, event: "session_revoked",
          result: "succeeded", reasonCode: "access_key_revoked",
        });
        sendJson(res, 200, { account: projectAccount(store.find("accounts", params.id)) });
      }
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

  router.put(
    "/api/accounts/:id/model",
    asHandler(async ({ req, res, params }) => {
      const body = await readJsonBody(req);
      const account = controlService?.updateAccountModel
        ? await controlService.updateAccountModel(params.id, body)
        : updateAccountModel(store, params.id, body);
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

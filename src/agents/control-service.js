// Vera Control Service: the single gateway authority for Agent credentials,
// Account Sessions, Account-bound Workspace admission, and Execution grants.

import { ApiError } from "../core/errors.js";
import { newAgentId } from "../core/id.js";
import { projectAgent } from "./agents.js";
import { ensureUnitBindings } from "./unit-bindings.js";
import {
  projectAccount,
  verifyAccountAccessKey,
} from "./accounts.js";
import { createAgentCredentialStore, bearerToken, headerValue } from "./credentials.js";
import { createAccountSessionService } from "./account-session.js";
import {
  assertWorkspaceAvailable,
  projectWorkspace,
  refreshWorkspaceBinding,
} from "../spaces/workspace-control.js";
import {
  authorizeDaemonExecution,
  releaseAccountExecutions,
} from "../spaces/execution-control.js";
import {
  accountResponse,
  invalid,
  requiredText,
  validateAuthorizeBody,
  validateEnrollBody,
  validateLoginBody,
  validateRegisterBody,
  validateRuntime,
} from "./control-contract.js";
import {
  deriveRuntimeRevision,
} from "../store/migrations/federation-account.mjs";

function reauth() {
  throw new ApiError("account_reauthentication_required", "Account Session requires reauthentication");
}


function requireAccount(store, accountId) {
  const account = store.find("accounts", accountId);
  if (!account) throw new ApiError("not_found", `account ${accountId} does not exist`);
  return account;
}

function requireAgent(store, agentId) {
  const agent = store.find("agents", agentId);
  if (!agent) throw new ApiError("unauthorized", "Agent token is not recognized");
  return agent;
}


export function createControlService({ store, config, memoryConfigService = null, agentStates = null, hub = null }) {
  const credentials = createAgentCredentialStore({ tokensPath: config.agentDaemon.tokensPath });
  const sessions = createAccountSessionService();
  let mutationTail = Promise.resolve();

  function serialized(task) {
    const next = mutationTail.catch(() => {}).then(task);
    mutationTail = next;
    return next;
  }

  async function authenticateAgent(headers) {
    const token = bearerToken(headers);
    if (!token) throw new ApiError("unauthorized", "Agent Token is required");
    const identity = await credentials.verify(token);
    if (!identity) throw new ApiError("unauthorized", "Agent Token is not recognized");
    const agent = requireAgent(store, identity.agentId);
    return { token, identity, agent };
  }

  function accountOwnerOrDelegation(account, agentId) {
    if (account.ownerAgentId !== agentId) {
      throw new ApiError("delegation_unavailable", "Agent is not the Account owner");
    }
  }

  function updateRuntime(agent, runtime) {
    validateRuntime(agent, runtime);
    const currentBinding = agent.runtimeBinding && typeof agent.runtimeBinding === "object"
      ? structuredClone(agent.runtimeBinding)
      : { connection: {} };
    currentBinding.runtimeSnapshot = {
      hostId: runtime.hostId,
      runtimeCapabilities: runtime.runtimeCapabilities,
      updatedAt: new Date().toISOString(),
    };
    const updated = store.update("agents", agent.id, {
      runtimeBinding: currentBinding,
      runtimeRevision: runtime.revision,
      updatedAt: new Date().toISOString(),
    });
    return updated;
  }

  function applyAccountRuntime(account, agent, runtime, binding) {
    return store.update("accounts", account.id, {
      workspace: binding,
      runtimeCapabilities: runtime.runtimeCapabilities,
      presence: "online",
      activeAgentId: agent.id,
      lastSeenAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }


  async function enroll(body, headers) {
    const input = validateEnrollBody(body);
    const accessKey = bearerToken(headers);
    if (!accessKey) throw new ApiError("unauthorized", "Account Key is required");
    return serialized(async () => {
      const account = requireAccount(store, input.accountId);
      if (!verifyAccountAccessKey(account, accessKey)) {
        throw new ApiError("unauthorized", "Account Key is not valid");
      }
      if (account.ownerAgentId !== null) {
        throw new ApiError("account_busy", "Account already has an owner Agent");
      }
      const now = new Date().toISOString();
      const agent = store.insert("agents", {
        id: newAgentId(),
        name: input.name,
        runtimeProfile: input.runtimeProfile,
        runtimeBinding: { connection: {} },
        runtimeRevision: deriveRuntimeRevision(input.runtimeProfile, { connection: {} }),
        createdAt: now,
        updatedAt: now,
      });
      let token;
      try {
        const updatedAccount = store.update("accounts", account.id, {
          ownerAgentId: agent.id,
          updatedAt: now,
        });
        token = await credentials.issue(agent.id);
        agentStates?.ensure?.(agent.id);
        ensureUnitBindings(store, agent.id);
        memoryConfigService?.ensureAgentConfig?.(agent.id);
        return { agent: projectAgent(agent), agentToken: token.token, account: projectAccount(updatedAccount) };
      } catch (error) {
        store.update("accounts", account.id, { ownerAgentId: null, updatedAt: now });
        store.remove("agents", agent.id);
        try {
          await credentials.revoke(agent.id);
        } catch {
          // Preserve the original failure; the token file is outside the
          // Account store and will be reconciled on the next enrollment.
        }
        throw error;
      }
    });
  }

  async function login(body, headers) {
    const input = validateLoginBody(body);
    const hasKey = Boolean(headerValue(headers, "x-vera-account-key"));
    const hasSession = Boolean(headerValue(headers, "x-vera-account-session"));
    if (hasKey && hasSession) invalid("Account Key and Account Session are mutually exclusive");
    if (!hasKey && !hasSession) reauth();
    const { identity, agent } = await authenticateAgent(headers);
    return serialized(async () => {
      const account = requireAccount(store, input.accountId);
      accountOwnerOrDelegation(account, agent.id);
      if (hasKey) {
        if (!verifyAccountAccessKey(account, headerValue(headers, "x-vera-account-key"))) {
          throw new ApiError("unauthorized", "Account Key is not valid");
        }
        const current = sessions.getAccountSession(account.id);
        const activeRun = store.list("runs").some((run) => run.accountId === account.id && ["pending", "running"].includes(run.status));
        if (current && (account.presence === "online" || activeRun)) {
          throw new ApiError("account_busy", "Account already has an active owner session");
        }
        const agentSession = sessions.getAgentSession(agent.id);
        if (agentSession && agentSession.accountId !== account.id) {
          throw new ApiError("account_busy", "Agent already has an Account session");
        }
      } else if (headerValue(headers, "x-vera-account-key")) {
        invalid("Account Key and Account Session are mutually exclusive");
      }

      let record = null;
      if (hasSession) {
        record = sessions.authenticate({
          token: headerValue(headers, "x-vera-account-session"),
          agentId: agent.id,
          accountId: account.id,
          agentTokenFingerprint: identity.fingerprint,
          accessKeyVersion: account.accessKeyVersion,
          daemonBootId: input.daemonBootId,
        });
      }

      // Complete binding validation is pure. Nothing below this point may
      // update Agent or Account until runtime and Workspace both match.
      validateRuntime(agent, input.runtime);
      const workspaceBinding = refreshWorkspaceBinding(account, input.workspace, {
        runtimeHostId: input.runtime.hostId,
      });

      if (record) {
        const updatedAgent = updateRuntime(agent, input.runtime);
        const updatedAccount = applyAccountRuntime(account, updatedAgent, input.runtime, workspaceBinding);
        sessions.updateRuntime(record, {
          runtimeHostId: input.runtime.hostId,
          runtimeRevision: input.runtime.revision,
        });
        return accountResponse(store, updatedAccount, updatedAgent, config, { record });
      }

      const updatedAgent = updateRuntime(agent, input.runtime);
      const updatedAccount = applyAccountRuntime(account, updatedAgent, input.runtime, workspaceBinding);
      const issued = sessions.issue({
        agentId: agent.id,
        accountId: account.id,
        agentTokenFingerprint: identity.fingerprint,
        accessKeyVersion: account.accessKeyVersion,
        daemonBootId: input.daemonBootId,
        runtimeHostId: input.runtime.hostId,
        runtimeRevision: input.runtime.revision,
      });
      return accountResponse(store, updatedAccount, updatedAgent, config, issued);
    });
  }

  async function authenticateAccountSession(body, headers) {
    if (headerValue(headers, "x-vera-account-key")) {
      invalid("Account Key is not accepted on a Session-authenticated endpoint");
    }
    const { identity, agent } = await authenticateAgent(headers);
    const accountId = requiredText(body.accountId, "accountId");
    const daemonBootId = body.daemonBootId === undefined ? undefined : requiredText(body.daemonBootId, "daemonBootId");
    const account = requireAccount(store, accountId);
    accountOwnerOrDelegation(account, agent.id);
    const sessionRecord = sessions.authenticate({
      token: headerValue(headers, "x-vera-account-session"),
      agentId: agent.id,
      accountId,
      agentTokenFingerprint: identity.fingerprint,
      accessKeyVersion: account.accessKeyVersion,
      daemonBootId,
    });
    const { tokenHash, ...session } = sessionRecord;
    return { account, agent, session };
  }

  async function registerWorkspace(body, headers) {
    const input = validateRegisterBody(body);
    return serialized(async () => {
      const { account, agent, session } = await authenticateAccountSession(input, headers);
      if (input.runtimeRevision !== agent.runtimeRevision || input.runtimeRevision !== session.runtimeRevision) {
        throw new ApiError("workspace_unavailable", "runtimeRevision does not match the active Agent runtime");
      }
      const binding = refreshWorkspaceBinding(account, input.workspace, { runtimeHostId: session.runtimeHostId });
      const updated = store.update("accounts", account.id, {
        workspace: binding,
        lastSeenAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return { workspace: projectWorkspace(updated.workspace) };
    });
  }

  async function authorizeWorkspace(body, headers) {
    const input = validateAuthorizeBody(body);
    return serialized(async () => {
      const { account, agent, session } = await authenticateAccountSession(input, headers);
      if (input.runtimeRevision !== agent.runtimeRevision || input.runtimeRevision !== session.runtimeRevision) {
        throw new ApiError("workspace_unavailable", "runtimeRevision does not match the active Agent runtime");
      }
      if (account.workspace?.hostId !== input.workspaceHostId || session.runtimeHostId !== input.workspaceHostId) {
        throw new ApiError("workspace_unavailable", "Workspace host is not admitted for this Account");
      }
      assertWorkspaceAvailable(account.workspace);
      const result = authorizeDaemonExecution({
        store,
        hub,
        runId: input.runId,
        account,
        agent,
        session,
        workspaceHostId: input.workspaceHostId,
        runtimeRevision: input.runtimeRevision,
      });
      return { execution: result.execution };
    });
  }

  async function logout(accountId, headers) {
    const { identity, agent } = await authenticateAgent(headers);
    const sessionToken = headerValue(headers, "x-vera-account-session");
    if (headerValue(headers, "x-vera-account-key")) {
      invalid("Account Key is not accepted on a Session-authenticated endpoint");
    }
    if (!sessionToken) reauth();
    return serialized(async () => {
      const account = requireAccount(store, accountId);
      accountOwnerOrDelegation(account, agent.id);
      sessions.authenticate({
        token: sessionToken,
        agentId: agent.id,
        accountId,
        agentTokenFingerprint: identity.fingerprint,
        accessKeyVersion: account.accessKeyVersion,
        daemonBootId: headerValue(headers, "x-vera-daemon-boot-id") || account.daemonBootId,
      });
      sessions.invalidateAccountSessions(accountId);
      releaseAccountExecutions(store, accountId);
      store.update("accounts", accountId, {
        presence: "offline",
        activeAgentId: null,
        runtimeCapabilities: null,
        lastSeenAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
  }

  return {
    gatewayBootId: sessions.bootId,
    enroll,
    login,
    authenticateAccountSession,
    registerWorkspace,
    authorizeWorkspace,
    logout,
    invalidateAccountSessions(accountId) {
      sessions.invalidateAccountSessions(accountId);
      releaseAccountExecutions(store, accountId);
    },
    getSession(accountId) {
      return sessions.getAccountSession(accountId);
    },
  };
}

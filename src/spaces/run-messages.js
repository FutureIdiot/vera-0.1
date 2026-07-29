import { ApiError } from "../core/errors.js";
import { newRunId, newRunMessageId } from "../core/id.js";
import { listAgentModels } from "../agents/account-models.js";
import { shouldRespond } from "./messages.js";

const ACTIVE = new Set(["pending", "running"]);
const KINDS = new Set([
  "delegate", "instruction", "progress", "result", "blocked", "acknowledgement",
]);

function stripInternal({ _seq, ...record }) {
  return structuredClone(record);
}

function requireText(value, field, maxChars) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("invalid_request", `${field} must be a non-empty string`);
  }
  const text = value.trim();
  if (text.length > maxChars) {
    throw new ApiError("invalid_request", `${field} exceeds its configured limit`);
  }
  return text;
}

function isAncestor(store, ancestorId, descendant) {
  let current = descendant;
  while (current?.parentRunId) {
    if (current.parentRunId === ancestorId) return true;
    current = store.find("runs", current.parentRunId);
  }
  return false;
}

function authorSnapshot(store, message) {
  if (message.author?.type === "user") return { type: "user", name: "User" };
  const accountId = message.author?.accountId;
  const account = accountId ? store.find("accounts", accountId) : null;
  return {
    type: "account",
    accountId,
    name: message.accountNameSnapshot ?? account?.name ?? "Account",
  };
}

export function createRunMessageService({
  store,
  hub,
  config,
  controlService,
  scheduleChildRun,
  notifyRunMessage,
  runBackground = null,
  now = () => new Date(),
} = {}) {
  if (!store || !hub || !config?.agentCommunication || !controlService ||
      typeof scheduleChildRun !== "function") {
    throw new Error("createRunMessageService dependencies are unavailable");
  }
  const limits = config.agentCommunication;

  function activeRun(runId) {
    const run = store.find("runs", runId);
    if (!run) throw new ApiError("not_found", `run ${runId} does not exist`);
    if (!ACTIVE.has(run.status)) throw new ApiError("conflict", `run ${runId} is terminal`);
    return run;
  }

  function delegationTargets(run) {
    const space = store.find("spaces", run.spaceId);
    if (!space || space.archivedAt) return [];
    if (space.spaceType === "garage") {
      return [];
    }
    return store.list("accounts")
      .filter((account) =>
        account.ownerAgentId &&
        account.ownerAgentId !== run.agentId &&
        account.activeAgentId === account.ownerAgentId &&
        account.presence === "online" &&
        controlService.getSession(account.id)?.agentId === account.ownerAgentId)
      .map((account) => ({
        agentId: account.ownerAgentId,
        accountId: account.id,
        name: account.name,
      }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.agentId.localeCompare(right.agentId));
  }

  function evidenceFor(run, sourceMessageIds = []) {
    if (!Array.isArray(sourceMessageIds) ||
        sourceMessageIds.length > limits.maxSourceMessageIds ||
        new Set(sourceMessageIds).size !== sourceMessageIds.length ||
        sourceMessageIds.some((id) => typeof id !== "string")) {
      throw new ApiError("invalid_request", "sourceMessageIds are invalid");
    }
    let chars = 0;
    return sourceMessageIds.map((sourceMessageId) => {
      const message = store.find("messages", sourceMessageId);
      if (!message || message.spaceId !== run.spaceId ||
          message.spaceSessionId !== run.spaceSessionId ||
          message.status !== "completed") {
        throw new ApiError("forbidden", `source Message ${sourceMessageId} is not readable by the sender Run`);
      }
      const content = typeof message.content === "string" ? message.content : "";
      chars += content.length;
      if (chars > limits.maxEvidenceChars) {
        throw new ApiError("invalid_request", "delegate evidence exceeds its configured limit");
      }
      return { sourceMessageId, authorSnapshot: authorSnapshot(store, message), content };
    });
  }

  function nextSequence(rootRunId) {
    return store.list("runMessages")
      .filter((message) => message.rootRunId === rootRunId)
      .reduce((highest, message) => Math.max(highest, message.sequence ?? 0), 0) + 1;
  }

  function assertRootCapacity(rootRunId) {
    if (store.list("runMessages").filter((message) => message.rootRunId === rootRunId).length >=
        limits.maxMessagesPerRoot) {
      throw new ApiError("conflict", "Root Run reached its internal message limit");
    }
  }

  function repeated(senderRunId, idempotencyKey) {
    const cutoff = now().getTime() - limits.idempotencyRetentionMs;
    return store.list("runMessages").find((message) =>
      message.sender?.type === "run" &&
      message.sender.runId === senderRunId &&
      message.idempotencyKey === idempotencyKey &&
      Date.parse(message.createdAt) >= cutoff) ?? null;
  }

  function createDelegate(senderRunId, input) {
    const sender = activeRun(senderRunId);
    const idempotencyKey = requireText(
      input?.idempotencyKey,
      "idempotencyKey",
      200,
    );
    const prior = repeated(sender.id, idempotencyKey);
    if (prior) {
      const priorChild = prior.recipient?.runId ? store.find("runs", prior.recipient.runId) : null;
      return { runMessage: stripInternal(prior), run: priorChild ? stripInternal(priorChild) : null };
    }
    if (input?.kind !== "delegate") {
      throw new ApiError("invalid_request", "createDelegate requires kind delegate");
    }
    if (typeof input.recipientAgentId !== "string") {
      throw new ApiError("invalid_request", "recipientAgentId is required");
    }
    if (sender.depth >= limits.maxDepth) {
      throw new ApiError("conflict", "Run reached the configured delegation depth");
    }
    const childCount = store.list("runs").filter((run) => run.parentRunId === sender.id).length;
    if (childCount >= limits.maxChildrenPerRun) {
      throw new ApiError("conflict", "Run reached its configured child limit");
    }
    assertRootCapacity(sender.rootRunId);
    const target = delegationTargets(sender).find((candidate) =>
      candidate.agentId === input.recipientAgentId);
    if (!target) throw new ApiError("forbidden", "recipient Agent is not an allowed delegation target");
    const recipientAgent = store.find("agents", target.agentId);
    const recipientAccount = store.find("accounts", target.accountId);
    const session = controlService.getSession(target.accountId);
    if (!recipientAgent || !recipientAccount || !session ||
        recipientAgent.id !== recipientAccount.ownerAgentId ||
        recipientAccount.activeAgentId !== recipientAgent.id ||
        recipientAccount.presence !== "online") {
      throw new ApiError("adapter_unavailable", "recipient Agent is offline");
    }
    const targetBlockers = store.list("runs").filter((run) =>
      run.accountId === recipientAccount.id && ACTIVE.has(run.status));
    const createsAccountCycle = targetBlockers.some((blocker) =>
      store.list("runs").some((candidate) =>
        ACTIVE.has(candidate.status) &&
        candidate.accountId === sender.accountId &&
        (candidate.id === blocker.id || isAncestor(store, blocker.id, candidate))));
    if (createsAccountCycle) {
      throw new ApiError("account_busy", "delegation would create a cyclic Account wait");
    }
    const models = listAgentModels(recipientAgent);
    if (!recipientAccount.model || !models.includes(recipientAccount.model)) {
      throw new ApiError("model_unavailable", "recipient Account model is unavailable");
    }
    const instruction = requireText(input.content, "content", limits.maxContentChars);
    const evidence = evidenceFor(sender, input.sourceMessageIds ?? []);
    const timestamp = now().toISOString();
    const childId = newRunId();
    const runMessageId = newRunMessageId();
    const child = store.insert("runs", {
      id: childId,
      agentId: recipientAgent.id,
      accountId: recipientAccount.id,
      accountNameSnapshot: recipientAccount.name,
      rootRunId: sender.rootRunId,
      parentRunId: sender.id,
      role: "child",
      depth: sender.depth + 1,
      outputPolicy: "source",
      spaceId: sender.spaceId,
      spaceSessionId: sender.spaceSessionId,
      agentSessionId: null,
      contextGeneration: null,
      runtimeRevision: recipientAgent.runtimeRevision ?? null,
      effectiveModel: recipientAccount.model,
      modelVersion: recipientAccount.modelVersion,
      delegated: false,
      triggerMessageId: input.sourceMessageIds?.[0] ?? sender.triggerMessageId,
      replyMessageIds: [],
      status: "pending",
      executionTransport: "daemon",
      accountSessionId: session.id,
      executionLeaseId: null,
      workspaceHostId: recipientAccount.workspace?.hostId ?? null,
      leaseAcquiredAt: null,
      backgroundEligibleAt: null,
      backgroundedAt: null,
      deferredByRunId: null,
      catchupId: null,
      apiResultVersion: null,
      createdAt: timestamp,
      endedAt: null,
    });
    const runMessage = store.insert("runMessages", {
      id: runMessageId,
      spaceId: sender.spaceId,
      spaceSessionId: sender.spaceSessionId,
      rootRunId: sender.rootRunId,
      sequence: nextSequence(sender.rootRunId),
      sender: { type: "run", runId: sender.id, agentId: sender.agentId },
      recipient: { type: "run", runId: child.id, agentId: child.agentId },
      kind: "delegate",
      content: instruction,
      sourceMessageIds: [...(input.sourceMessageIds ?? [])],
      idempotencyKey,
      deliveryState: "queued",
      createdAt: timestamp,
      deliveredAt: null,
    });
    scheduleChildRun({
      run: stripInternal(child),
      agent: recipientAgent,
      account: recipientAccount,
      space: store.find("spaces", sender.spaceId),
      delegatePacket: {
        instruction,
        evidence,
        sourceRunId: sender.id,
      },
      initialRunMessageId: runMessage.id,
    });
    return { runMessage: stripInternal(runMessage), run: stripInternal(child) };
  }

  function createMessage(senderRunId, input) {
    const sender = activeRun(senderRunId);
    if (!KINDS.has(input?.kind) || input.kind === "delegate") {
      throw new ApiError("invalid_request", "RunMessage kind is invalid");
    }
    const idempotencyKey = requireText(input.idempotencyKey, "idempotencyKey", 200);
    const prior = repeated(sender.id, idempotencyKey);
    if (prior) return { runMessage: stripInternal(prior) };
    assertRootCapacity(sender.rootRunId);
    let recipient;
    if (input.recipient?.type === "user") {
      if (sender.role !== "root" || sender.outputPolicy !== "source" ||
          !["progress", "result", "blocked"].includes(input.kind)) {
        throw new ApiError("forbidden", "this Run cannot send a private User message");
      }
      recipient = { type: "user" };
    } else {
      const recipientRunId = input.recipient?.runId ?? sender.parentRunId;
      const target = recipientRunId ? store.find("runs", recipientRunId) : null;
      if (!target || target.rootRunId !== sender.rootRunId || !ACTIVE.has(target.status)) {
        throw new ApiError("conflict", "recipient Run is unavailable");
      }
      if (input.kind === "instruction") {
        if (!isAncestor(store, sender.id, target)) {
          throw new ApiError("forbidden", "instruction recipient must be a descendant Run");
        }
      } else if (!isAncestor(store, target.id, sender)) {
        throw new ApiError("forbidden", "result recipient must be an ancestor Run");
      }
      recipient = { type: "run", runId: target.id, agentId: target.agentId };
    }
    const timestamp = now().toISOString();
    const message = store.insert("runMessages", {
      id: newRunMessageId(),
      spaceId: sender.spaceId,
      spaceSessionId: sender.spaceSessionId,
      rootRunId: sender.rootRunId,
      sequence: nextSequence(sender.rootRunId),
      sender: { type: "run", runId: sender.id, agentId: sender.agentId },
      recipient,
      kind: input.kind,
      content: requireText(input.content, "content", limits.maxContentChars),
      sourceMessageIds: [],
      idempotencyKey,
      deliveryState: "queued",
      createdAt: timestamp,
      deliveredAt: null,
    });
    if (recipient.type === "user") {
      hub.publish("run-message.user.created", {
        runMessage: {
          id: message.id,
          spaceId: message.spaceId,
          rootRunId: message.rootRunId,
          kind: message.kind,
          content: message.content,
          createdAt: message.createdAt,
        },
      });
    } else {
      notifyRunMessage?.(recipient.runId, message.sequence);
    }
    return { runMessage: stripInternal(message) };
  }

  function createUserInstruction(runId, input) {
    const run = activeRun(runId);
    if (run.role !== "root" || run.outputPolicy !== "source") {
      throw new ApiError("forbidden", "User instructions are only accepted by a private Root Run");
    }
    const replyTo = store.find("runMessages", input?.replyToRunMessageId);
    if (!replyTo || replyTo.rootRunId !== run.rootRunId ||
        replyTo.recipient?.type !== "user" ||
        !["progress", "result", "blocked"].includes(replyTo.kind)) {
      throw new ApiError("conflict", "replyToRunMessageId does not identify this Root's User message");
    }
    const idempotencyKey = requireText(input.idempotencyKey, "idempotencyKey", 200);
    const prior = store.list("runMessages").find((message) =>
      message.sender?.type === "user" &&
      message.recipient?.runId === run.id &&
      message.idempotencyKey === idempotencyKey);
    if (prior) return { runMessage: stripInternal(prior) };
    assertRootCapacity(run.rootRunId);
    const timestamp = now().toISOString();
    const message = store.insert("runMessages", {
      id: newRunMessageId(),
      spaceId: run.spaceId,
      spaceSessionId: run.spaceSessionId,
      rootRunId: run.rootRunId,
      sequence: nextSequence(run.rootRunId),
      sender: { type: "user" },
      recipient: { type: "run", runId: run.id, agentId: run.agentId },
      kind: "instruction",
      content: requireText(input.content, "content", limits.maxContentChars),
      sourceMessageIds: [],
      idempotencyKey,
      replyToRunMessageId: replyTo.id,
      deliveryState: "queued",
      createdAt: timestamp,
      deliveredAt: null,
    });
    notifyRunMessage?.(run.id, message.sequence);
    return { runMessage: stripInternal(message) };
  }

  function completeSourceRun(runId, { status, content, error } = {}) {
    const run = activeRun(runId);
    if (run.outputPolicy !== "source") return null;
    if (run.role === "child") {
      const parent = run.parentRunId ? store.find("runs", run.parentRunId) : null;
      if (!parent || !ACTIVE.has(parent.status)) return null;
    }
    const kind = status === "completed" ? "result" : "blocked";
    const body = status === "completed"
      ? (typeof content === "string" && content.trim() ? content.trim() : "Run completed without a result.")
      : `Run ${status ?? "failed"}: ${error?.message ?? "execution did not complete"}`;
    return createMessage(run.id, {
      kind,
      ...(run.role === "root" ? { recipient: { type: "user" } } : {}),
      content: body,
      idempotencyKey: `terminal:${run.id}`,
    }).runMessage;
  }

  function inbox(runId, after = 0) {
    const run = activeRun(runId);
    if (!Number.isInteger(after) || after < 0) throw new ApiError("invalid_request", "after must be a non-negative integer");
    const timestamp = now().toISOString();
    const timeoutBoundary = Date.parse(timestamp) - limits.deliveryTimeoutMs;
    for (const message of store.list("runMessages")) {
      if (message.recipient?.type !== "run" ||
          message.recipient.runId !== run.id ||
          !["queued", "delivered"].includes(message.deliveryState) ||
          Date.parse(message.createdAt) > timeoutBoundary) {
        continue;
      }
      store.update("runMessages", message.id, {
        deliveryState: "failed",
        deliveredAt: message.deliveredAt ?? timestamp,
      });
    }
    const messages = store.list("runMessages")
      .filter((message) =>
        message.recipient?.type === "run" &&
        message.recipient.runId === run.id &&
        message.sequence > after &&
        ["queued", "delivered"].includes(message.deliveryState))
      .sort((left, right) => left.sequence - right.sequence)
      .map((message) => {
        if (message.deliveryState === "queued") {
          return store.update("runMessages", message.id, {
            deliveryState: "delivered",
            deliveredAt: timestamp,
          });
        }
        return message;
      });
    return { runMessages: messages.map(stripInternal) };
  }

  function consume(runId, runMessageId) {
    const run = activeRun(runId);
    const message = store.find("runMessages", runMessageId);
    if (!message || message.recipient?.type !== "run" || message.recipient.runId !== run.id) {
      throw new ApiError("not_found", `run message ${runMessageId} does not exist`);
    }
    if (message.deliveryState === "consumed") return stripInternal(message);
    if (!["queued", "delivered"].includes(message.deliveryState)) {
      throw new ApiError("conflict", "run message is not consumable");
    }
    return stripInternal(store.update("runMessages", message.id, {
      deliveryState: "consumed",
      deliveredAt: message.deliveredAt ?? now().toISOString(),
    }));
  }

  function markInitialConsumed(runMessageId) {
    const message = store.find("runMessages", runMessageId);
    if (!message || message.kind !== "delegate" ||
        !["queued", "delivered", "consumed"].includes(message.deliveryState)) {
      return null;
    }
    if (message.deliveryState === "consumed") return message;
    return store.update("runMessages", message.id, {
      deliveryState: "consumed",
      deliveredAt: message.deliveredAt ?? now().toISOString(),
    });
  }

  function failRecipient(runId) {
    const timestamp = now().toISOString();
    const failed = [];
    for (const message of store.list("runMessages")) {
      if (message.recipient?.type !== "run" ||
          message.recipient.runId !== runId ||
          !["queued", "delivered"].includes(message.deliveryState)) {
        continue;
      }
      failed.push(store.update("runMessages", message.id, {
        deliveryState: "failed",
        deliveredAt: message.deliveredAt ?? timestamp,
      }));
    }
    return failed.map(stripInternal);
  }

  function routeAccountMessage(message) {
    if (!message || message.author?.type !== "account" || message.status !== "completed") return [];
    const sender = message.runId ? store.find("runs", message.runId) : null;
    if (!sender || !ACTIVE.has(sender.status) || sender.accountId !== message.author.accountId) {
      return [];
    }
    const space = store.find("spaces", message.spaceId);
    if (!space || space.archivedAt) return [];
    const created = [];
    for (const seat of space.seats ?? []) {
      if (seat.accountId === sender.accountId || !shouldRespond(seat, message)) continue;
      const account = store.find("accounts", seat.accountId);
      if (!account?.ownerAgentId) continue;
      const alreadyRespondingToTrigger = store.list("runs").some((run) =>
        run.role === "root" &&
        run.accountId === account.id &&
        run.spaceSessionId === sender.spaceSessionId &&
        run.triggerMessageId === sender.triggerMessageId &&
        ACTIVE.has(run.status));
      if (alreadyRespondingToTrigger) continue;
      try {
        created.push(createDelegate(sender.id, {
          kind: "delegate",
          recipientAgentId: account.ownerAgentId,
          content: message.content,
          sourceMessageIds: [message.id],
          idempotencyKey: `public:${message.id}:${account.ownerAgentId}`,
        }));
        runBackground?.excludeTrigger?.(space.id, account.id, message.id);
      } catch {
        // The public Message remains authoritative. A recipient that became
        // unavailable between projection and routing is not replaced or
        // retried through a different Agent.
      }
    }
    return created;
  }

  return {
    delegationTargets,
    createDelegate,
    createMessage,
    createUserInstruction,
    completeSourceRun,
    inbox,
    consume,
    markInitialConsumed,
    failRecipient,
    routeAccountMessage,
  };
}

import { asHandler, readJsonBody, sendJson } from "../api/http.js";
import { ApiError } from "../core/errors.js";

const VISIBILITIES = new Set(["status-only", "observed"]);

function publicState(state) {
  return structuredClone(state);
}

function assertBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length !== 2 ||
      !Object.hasOwn(body, "spaceId") ||
      !Object.hasOwn(body, "ifRevision")) {
    throw new ApiError("invalid_request", "body must be exactly { spaceId, ifRevision }");
  }
  if (body.spaceId !== null && (typeof body.spaceId !== "string" || !body.spaceId)) {
    throw new ApiError("invalid_request", "spaceId must be a non-empty string or null");
  }
  if (!Number.isInteger(body.ifRevision) || body.ifRevision < 0) {
    throw new ApiError("invalid_request", "ifRevision must be a non-negative integer");
  }
}

export function createObservationService({ store, hub, dispatchRunVisibility } = {}) {
  if (!store || !hub) throw new TypeError("createObservationService requires store and hub");
  let state = { observedSpaceId: null, revision: 0 };

  function isObservable(spaceId) {
    const space = store.find("spaces", spaceId);
    return Boolean(space && !space.archivedAt && space.seats?.length === 1);
  }

  function visibilityForSpace(spaceId) {
    return state.observedSpaceId === spaceId && isObservable(spaceId) ? "observed" : "status-only";
  }

  function visibilityForRun(run) {
    return visibilityForSpace(run?.spaceId);
  }

  function dispatchAffected(previousSpaceId, nextSpaceId) {
    const affected = new Set([previousSpaceId, nextSpaceId].filter(Boolean));
    for (const run of store.list("runs")) {
      if (run.status !== "running" || run.executionTransport !== "daemon" || !affected.has(run.spaceId)) continue;
      try {
        dispatchRunVisibility?.({
          accountId: run.accountId,
          event: {
            type: "run.activity-visibility.updated",
            data: {
              runId: run.id,
              activityVisibility: visibilityForRun(run),
            },
          },
        });
      } catch {
        // The canonical state and gateway write guard remain authoritative.
        // A new Run always receives a fresh visibility snapshot.
      }
    }
  }

  function commit(nextSpaceId) {
    if (state.observedSpaceId === nextSpaceId) return publicState(state);
    const previousSpaceId = state.observedSpaceId;
    state = { observedSpaceId: nextSpaceId, revision: state.revision + 1 };
    dispatchAffected(previousSpaceId, nextSpaceId);
    const observation = publicState(state);
    hub.publish("observation.updated", { observation });
    return observation;
  }

  function update(body) {
    assertBody(body);
    if (body.ifRevision !== state.revision) {
      throw new ApiError("conflict", "observation revision changed");
    }
    if (body.spaceId !== null && !isObservable(body.spaceId)) {
      const space = store.find("spaces", body.spaceId);
      if (!space) throw new ApiError("not_found", `space ${body.spaceId} does not exist`);
      throw new ApiError("conflict", "only an active single-Account Space can be observed");
    }
    return commit(body.spaceId);
  }

  function reconcileSpace(spaceId) {
    if (state.observedSpaceId !== spaceId || isObservable(spaceId)) return publicState(state);
    return commit(null);
  }

  function projectActivity(activity, { archived = false } = {}) {
    const projected = structuredClone(activity);
    if (archived || visibilityForSpace(activity?.spaceId) !== "observed") projected.detail = null;
    return projected;
  }

  return {
    get: () => publicState(state),
    update,
    reconcileSpace,
    visibilityForSpace,
    visibilityForRun,
    projectActivity,
    isVisibility: (value) => VISIBILITIES.has(value),
  };
}

export function registerObservationRoutes(router, { observation }) {
  router.put(
    "/api/observation",
    asHandler(async ({ req, res }) => {
      const body = await readJsonBody(req);
      sendJson(res, 200, { observation: observation.update(body) });
    }),
  );
}

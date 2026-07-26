// Project CRUD。Project 是导航组织资源，Space 通过 projectId 可选归属。

import { newProjectId } from "../core/id.js";
import { ApiError } from "../core/errors.js";

function stripInternal({ _seq, ...rest }) {
  return rest;
}

function assertExactObject(value, allowed, { required = [], name = "body" } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("invalid_request", `${name} must be an object`);
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    throw new ApiError("invalid_request", `${name} fields are invalid`);
  }
}

function normalizeName(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("invalid_request", "name must be a non-empty string");
  }
  return value.trim();
}

export function listProjects(store) {
  return store.list("projects")
    .map(stripInternal)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export function getProjectOrThrow(store, id) {
  const project = store.find("projects", id);
  if (!project) throw new ApiError("not_found", `project ${id} does not exist`);
  return stripInternal(project);
}

export function createProject(store, body) {
  assertExactObject(body, ["name"], { required: ["name"] });
  const now = new Date().toISOString();
  return stripInternal(store.insert("projects", {
    id: newProjectId(),
    name: normalizeName(body.name),
    createdAt: now,
    updatedAt: now,
  }));
}

export function updateProject(store, id, patch) {
  if (!store.find("projects", id)) {
    throw new ApiError("not_found", `project ${id} does not exist`);
  }
  assertExactObject(patch, ["name"], { required: ["name"], name: "patch" });
  return stripInternal(store.update("projects", id, {
    name: normalizeName(patch.name),
    updatedAt: new Date().toISOString(),
  }));
}

export function deleteProject(store, id) {
  if (!store.find("projects", id)) {
    throw new ApiError("not_found", `project ${id} does not exist`);
  }
  const referencingSpace = store.list("spaces").find((space) => space.projectId === id);
  if (referencingSpace) {
    throw new ApiError("conflict", `project ${id} is referenced by space ${referencingSpace.id}`);
  }
  store.remove("projects", id);
}

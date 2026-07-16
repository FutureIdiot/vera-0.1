// Built-in Memory Provider capability declaration. This is a concrete
// vera.markdown contract, not a provider registry or compatibility layer.

export const VERA_MARKDOWN_CAPABILITIES = Object.freeze({
  list: true,
  fetch: true,
  search: true,
  create: true,
  update: true,
  archive: true,
  delete: true,
  sources: true,
  versioning: true,
  pin: true,
  links: true,
  usage: true,
  externalEdit: true,
  digest: Object.freeze({
    ingest: Object.freeze(["create", "update", "supersede", "archive"]),
  }),
  dream: Object.freeze({
    maintenance: Object.freeze(["update", "merge", "archive", "structureRewrite"]),
  }),
});

export function requireDreamProviderCapabilities(capabilities, action) {
  if (action === "keep") return;
  const supported = new Set(capabilities?.dream?.maintenance ?? []);
  const required = action === "update"
    ? ["update", "structureRewrite"]
    : action === "merge"
      ? ["merge", "update", "archive"]
      : ["archive"];
  if (required.some((operation) => !supported.has(operation))) {
    const error = new Error(`Memory Provider does not support Dream ${action}`);
    error.code = "memory_provider_unsupported";
    throw error;
  }
}

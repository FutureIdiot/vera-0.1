function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function cloneJson(value, label) {
  try {
    return JSON.parse(JSON.stringify(value ?? {}));
  } catch {
    throw new TypeError(`${label} must be JSON-serializable`);
  }
}

/**
 * Build the only host object supplied to an extension initializer. It contains
 * no store, filesystem, secret, process, request, or arbitrary execution API.
 */
export function createExtensionContext({ manifest, componentIds, agentId, config, register }) {
  const allowed = new Set(componentIds);
  const safeConfig = deepFreeze(cloneJson(config, "binding config"));
  const registrations = [];
  const registerCapability = (descriptor) => {
    if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
      throw new TypeError("capability descriptor must be an object");
    }
    if (!allowed.has(descriptor.componentId)) throw new TypeError("capability is not declared by the manifest");
    const record = deepFreeze({
      componentId: descriptor.componentId,
      ...(descriptor.name === undefined ? {} : { name: String(descriptor.name) }),
      ...(descriptor.metadata === undefined ? {} : { metadata: cloneJson(descriptor.metadata, "capability metadata") }),
    });
    registrations.push(record);
    register(record);
    return record;
  };

  const extensionId = manifest.extensionId ?? manifest.id;
  const safeRegister = (value) => { register?.(value); return value; };
  return deepFreeze({
    version: 1,
    extension: { id: extensionId, version: manifest.version },
    agent: { id: agentId },
    extensionId,
    agentId,
    config: safeConfig,
    register: safeRegister,
    capabilities: deepFreeze({ register: registerCapability }),
  });
}

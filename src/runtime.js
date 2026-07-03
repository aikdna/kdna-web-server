let cachedRuntime = null;

export async function loadDefaultRuntime() {
  if (cachedRuntime) return cachedRuntime;

  try {
    const mod = await import('@aikdna/kdna-core/v1');
    cachedRuntime = mod.default && Object.keys(mod.default).length > 0
      ? { ...mod.default, ...mod }
      : mod;
    return cachedRuntime;
  } catch (error) {
    const wrapped = new Error(
      '@aikdna/kdna-core is required. Install it in the host application or pass a runtime option.',
    );
    wrapped.cause = error;
    wrapped.code = 'KDNA_CORE_NOT_AVAILABLE';
    throw wrapped;
  }
}

export async function resolveRuntime(options = {}) {
  return options.runtime || loadDefaultRuntime();
}

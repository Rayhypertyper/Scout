(() => {
  if (globalThis.ScoutWorkdaySessionStore) return;

  function create(storage, key) {
    let queue = Promise.resolve();

    function read() {
      const pending = queue;
      return pending.then(async () => {
        const stored = await storage.get(key);
        const value = stored?.[key];
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
      });
    }

    function update(mutator) {
      const operation = async () => {
        const stored = await storage.get(key);
        const current = stored?.[key] && typeof stored[key] === "object" && !Array.isArray(stored[key])
          ? stored[key] : {};
        const result = await mutator(current);
        await storage.set({ [key]: current });
        return result;
      };
      const pending = queue.then(operation, operation);
      queue = pending.then(() => undefined, () => undefined);
      return pending;
    }

    return Object.freeze({ read, update });
  }

  globalThis.ScoutWorkdaySessionStore = Object.freeze({ create });
})();

(() => {
  const key = "scoutApplicationHelper";
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const seedState = () => ({
    version: 1,
    profile: {
      experienceCount: 2,
      experience: [
        { title: "Synthetic preview role one", company: "Example Company A", location: "Sample City", startDate: "2024", endDate: "2024-05", description: "Synthetic preview data.", currentlyWorkHere: false },
        { title: "Synthetic preview role two", company: "Example Company B", location: "Sample City", startDate: "2023-02", endDate: "2023-06", description: "Synthetic preview data.", currentlyWorkHere: false },
      ],
      websites: Array.from({ length: 4 }, () => ({ url: "" })),
    },
    documents: { resume: null, coverLetter: null },
  });

  if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(seedState()));

  const storageChanged = { addListener() {}, removeListener() {} };
  const runtimeMessages = { addListener() {}, removeListener() {} };
  globalThis.chrome = {
    storage: {
      local: {
        async get(name) {
          const value = localStorage.getItem(name);
          return value ? { [name]: JSON.parse(value) } : {};
        },
        async set(values) {
          for (const [name, value] of Object.entries(values)) localStorage.setItem(name, JSON.stringify(value));
        },
        async setAccessLevel() {},
      },
      onChanged: storageChanged,
    },
    runtime: {
      onMessage: runtimeMessages,
      async sendMessage(message) {
        if (message?.type === "scout.saveHelperState") {
          const state = clone(message.state);
          localStorage.setItem(key, JSON.stringify(state));
          return { saved: true, state };
        }
        if (message?.type === "scout.getWorkdaySession") return { active: false };
        return { ok: false, message: "Preview mode disables browser actions and Scout sync." };
      },
    },
    permissions: {
      async contains() { return false; },
      async request() { return false; },
      async remove() { return true; },
    },
    tabs: {
      async query() { return []; },
      async create() { throw new Error("Preview mode does not open tabs."); },
      async get() { return null; },
      async remove() {},
    },
    scripting: { async executeScript() { return []; } },
  };

  document.addEventListener("DOMContentLoaded", () => {
    const banner = document.createElement("aside");
    banner.setAttribute("role", "note");
    banner.style.cssText = "padding:8px 14px;background:var(--lime);color:var(--signal-ink);font:12px/1.4 inherit;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:12px";
    const label = document.createElement("span");
    label.textContent = "Local popup preview · mocked browser storage · ATS and Scout sync disabled.";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "Reset preview";
    reset.style.cssText = "flex:0 0 auto;border:1px solid var(--forest-muted);background:var(--paper);color:var(--signal-ink);padding:5px 8px;border-radius:3px";
    reset.addEventListener("click", () => {
      localStorage.removeItem(key);
      location.reload();
    });
    banner.append(label, reset);
    document.body.prepend(banner);
  }, { once: true });
})();

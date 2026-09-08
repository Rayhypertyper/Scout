const MOTION_SOURCES = Object.freeze([
  "/vendor/gsap.min.js",
  "/vendor/ScrollTrigger.min.js",
]);

const documentStates = new WeakMap();

function stateFor(documentRef) {
  let state = documentStates.get(documentRef);
  if (!state) {
    state = { scripts: new Map(), runtimePromise: null };
    documentStates.set(documentRef, state);
  }
  return state;
}

function loadScript(src, documentRef, state) {
  const pending = state.scripts.get(src);
  if (pending) return pending;

  const promise = new Promise((resolve, reject) => {
    const script = documentRef.createElement("script");
    script.src = src;
    script.async = false;
    script.dataset.scoutMotionLoader = "true";
    script.onload = () => resolve(script);
    script.onerror = () => {
      state.scripts.delete(src);
      reject(new Error(`Unable to load ${src}`));
    };
    const append = documentRef.head?.append || documentRef.head?.appendChild;
    if (!append) {
      state.scripts.delete(src);
      reject(new Error("The document head cannot append scripts"));
      return;
    }
    append.call(documentRef.head, script);
  });

  state.scripts.set(src, promise);
  return promise;
}

/**
 * Load the optional landing motion runtime in dependency order.
 * Returns null when the runtime is unavailable so the static CSS/DOM path
 * remains usable, including when a vendor request fails or is blocked.
 */
export function loadMotionRuntime({ documentRef = globalThis.document, windowRef = globalThis.window } = {}) {
  if (!documentRef?.createElement || !documentRef.head || !windowRef) return Promise.resolve(null);

  const state = stateFor(documentRef);
  if (state.runtimePromise) return state.runtimePromise;

  if (windowRef.gsap && windowRef.ScrollTrigger) {
    return Promise.resolve({ gsap: windowRef.gsap, ScrollTrigger: windowRef.ScrollTrigger });
  }

  state.runtimePromise = (async () => {
    try {
      for (const src of MOTION_SOURCES) await loadScript(src, documentRef, state);
    } catch {
      return null;
    }
    if (!windowRef.gsap || !windowRef.ScrollTrigger) return null;
    return { gsap: windowRef.gsap, ScrollTrigger: windowRef.ScrollTrigger };
  })();

  return state.runtimePromise.then((runtime) => {
    if (!runtime) state.runtimePromise = null;
    return runtime;
  });
}

export { MOTION_SOURCES };

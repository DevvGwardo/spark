import "@testing-library/jest-dom/vitest";

if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    }),
  });

  // Node >= 26 defines a globalThis.localStorage getter that returns undefined
  // unless --localstorage-file is passed. Vitest's jsdom env leaves it in
  // place (the key already exists on globalThis, so it shadows jsdom's working
  // localStorage), which breaks zustand persist and other web-storage
  // consumers in tests. Restore jsdom's implementation here.
  if (typeof window.localStorage === "undefined") {
    const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;
    if (dom && Object.getOwnPropertyDescriptor(window, "localStorage")?.configurable) {
      try {
        Object.defineProperty(window, "localStorage", {
          configurable: true,
          value: dom.window.localStorage,
        });
      } catch {
        // non-configurable in some environments — nothing else we can do
      }
    }
  }
}

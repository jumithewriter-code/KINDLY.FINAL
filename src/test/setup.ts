import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import { toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

// These tests drive the real providers, so a query round trip plus a couple of
// re-renders can take longer than the 1s default on a loaded machine.
configure({ asyncUtilTimeout: 5000 });

// jsdom has no matchMedia; several components ask about reduced motion.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// jsdom has no BroadcastChannel in older versions; the memory backend uses it
// for cross-tab sync and must degrade quietly without it.
if (typeof BroadcastChannel === 'undefined') {
  // @ts-expect-error - deliberately minimal test stand-in
  globalThis.BroadcastChannel = class {
    onmessage: ((e: MessageEvent) => void) | null = null;
    postMessage() {}
    close() {}
  };
}

if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      ...globalThis.crypto,
      randomUUID: () => `${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`,
      getRandomValues: (arr: Uint8Array) => arr.map(() => Math.floor(Math.random() * 256)),
    },
    configurable: true,
  });
}

// speechSynthesis is used by the optional read-aloud control.
if (typeof window !== 'undefined' && !('speechSynthesis' in window)) {
  Object.defineProperty(window, 'speechSynthesis', {
    value: { speak: vi.fn(), cancel: vi.fn() },
    configurable: true,
  });
  // @ts-expect-error - test stand-in
  window.SpeechSynthesisUtterance = class { constructor(public text: string) {} rate = 1; };
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

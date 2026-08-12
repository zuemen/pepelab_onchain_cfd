import type { ReactNode } from 'react';

import { useMemo, useState, useContext, useCallback, createContext } from 'react';

// ----------------------------------------------------------------------
// Simple ↔ Expert mode. This is the foundation the redesigned Dashboard
// (and, over time, the rest of the app) builds on: which nav items show,
// which vocabulary is used, which sections render.
//
// Refactored out of a version that had three separate problems:
//  1. `localStorage.getItem(...) as Mode ?? 'simple'` cast the raw string
//     straight to Mode without validating it. Any garbage value (hand-edited
//     storage, a stale key from an older build) would silently pass through
//     and make every `mode === 'expert'` check false forever, with no error
//     to explain why "switching modes" looked broken.
//  2. The context value object was a fresh literal on every render, so every
//     consumer re-rendered on any state change anywhere above it in the tree,
//     not just on a real mode change.
//  3. `setMode` dispatched a `pepefi:mode-changed` CustomEvent that nothing
//     in the codebase ever listened for — dead code kept alive by nothing.

export type Mode = 'simple' | 'expert';

const STORAGE_KEY = 'pepefi:mode';
const DEFAULT_MODE: Mode = 'simple';

const isMode = (v: unknown): v is Mode => v === 'simple' || v === 'expert';

/** Read the persisted mode, falling back to the default for anything invalid. */
export function readStoredMode(): Mode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isMode(raw) ? raw : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

export function writeStoredMode(mode: Mode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* storage unavailable (private mode / quota) — mode just won't persist */
  }
}

type ModeContextValue = {
  mode: Mode;
  setMode: (m: Mode) => void;
  toggle: () => void;
};

const ModeContext = createContext<ModeContextValue | null>(null);

export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>(readStoredMode);

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    writeStoredMode(m);
  }, []);

  const toggle = useCallback(() => {
    setModeState(prev => {
      const next: Mode = prev === 'simple' ? 'expert' : 'simple';
      writeStoredMode(next);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ mode, setMode, toggle }), [mode, setMode, toggle]);

  return (
    <ModeContext.Provider value={value}>
      {children}
    </ModeContext.Provider>
  );
}

export function useMode(): ModeContextValue {
  const ctx = useContext(ModeContext);
  // ModeProvider wraps the app root in App.tsx, so this can only fire if a
  // future refactor moves a consumer outside it — better a clear error here
  // than the old `null!` producing a silently-undefined mode downstream.
  if (!ctx) throw new Error('useMode must be used within a ModeProvider');
  return ctx;
}

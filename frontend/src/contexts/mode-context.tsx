import { useState, useContext, createContext } from 'react';

// ----------------------------------------------------------------------

type Mode = 'simple' | 'expert';

type ModeContextValue = {
  mode: Mode;
  setMode: (m: Mode) => void;
  toggle: () => void;
};

const ModeContext = createContext<ModeContextValue>(null!);

export function ModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<Mode>(() => {
    try { return (localStorage.getItem('pepefi:mode') as Mode) ?? 'simple'; }
    catch { return 'simple'; }
  });

  const setMode = (m: Mode) => {
    setModeState(m);
    try { localStorage.setItem('pepefi:mode', m); } catch (_) { /* ignore */ }
    window.dispatchEvent(new CustomEvent('pepefi:mode-changed', { detail: m }));
  };

  const toggle = () => setMode(mode === 'simple' ? 'expert' : 'simple');

  return (
    <ModeContext.Provider value={{ mode, setMode, toggle }}>
      {children}
    </ModeContext.Provider>
  );
}

export const useMode = () => useContext(ModeContext);

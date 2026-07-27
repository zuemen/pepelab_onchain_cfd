/// <reference types="vite/client" />

// Note: `window.ethereum` is declared once in src/hooks/useWallet.ts via
// `declare global`, using ethers' own Eip1193Provider type. Do not redeclare it
// here — a second, weaker declaration conflicts with it (TS2717) and makes the
// event handlers optional, which breaks useWallet's listener wiring.

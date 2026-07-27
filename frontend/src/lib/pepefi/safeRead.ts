// Chain-read resilience helpers.
//
// A page that reads N values from chain in a Promise.all fails entirely when any
// one of them rejects — an undeployed contract on this network, a flaky RPC, a
// reverting view. The symptom is the whole page going blank or every number
// snapping to zero, which is what these are here to prevent.
//
// Wrap each element so a single bad read degrades to a fallback instead of
// taking its neighbours with it.

/** Reject after `ms` so a hung RPC call can never block a page from settling. */
export function withTimeout<T>(p: Promise<T>, ms = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('rpc timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Resolve a single chain read to `fallback` on ANY error or timeout.
 * Never throws, never hangs — safe to put inside Promise.all.
 */
export async function safeRead<T>(p: Promise<T>, fallback: T, ms = 8000): Promise<T> {
  try {
    return await withTimeout(p, ms);
  } catch {
    return fallback;
  }
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

/**
 * True when a contract is actually deployed on the current chain.
 * addresses.ts uses 0x0 for "not deployed here", and calling a view on 0x0
 * throws — so guard reads with this rather than discovering it at runtime.
 */
export function isDeployed(target: unknown): boolean {
  return typeof target === 'string' ? target !== ZERO_ADDR : String(target) !== ZERO_ADDR;
}

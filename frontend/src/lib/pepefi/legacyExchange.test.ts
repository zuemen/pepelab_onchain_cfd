import type { LegacyExchange } from 'src/contracts/legacyExchanges';
import type { LegacyReader, LegacyExchangeScan } from './legacyExchange';

import { it, expect, describe } from 'vitest';
import { id, AbiCoder, Interface, ZeroAddress, zeroPadValue } from 'ethers';

import { t } from 'src/locales';

import fixtures from './__fixtures__/legacyBytecode.json';
import {
  planWithdraw,
  needsOperator,
  scanHasAssets,
  LEGACY_SELECTORS,
  probeCapabilities,
  legacyEntryVisible,
  scanLegacyExchange,
  legacyBlockMessage,
  scanPush4Selectors,
  settlesAtStalePrice,
  classifyLegacyRevert,
  decodePositionPrefix,
  LEGACY_ERROR_SELECTORS,
  ABANDONED_PRICE_AGE_SEC,
} from './legacyExchange';

// ----------------------------------------------------------------------

const coder = AbiCoder.defaultAbiCoder();
const NOW = 1_790_833_300;
const USER = '0x858b36C788296051b09512fC6cE9EdBEeF0bA972';
const OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const EXCHANGE: LegacyExchange = {
  chainId: 84532,
  address: '0xfAEf549C687C37064cEaB5728989a839B08955cf',
  activeFrom: '2026-09-04',
  activeUntil: '2026-09-10',
  abiSource: 'test',
};
const USDC = '0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035';
const ORACLE = '0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3';
const sETH = '0x83e22e1d95f2093dd401ec5cba75bcd950cd90282356f086011849e4fbaad8a9';
const sAAPL = '0xeed17252f75eebef59a2839f0991464677fec970326e35128ddaf7f3acfb7220';

const E = new Interface([
  'error StalePrice(bytes32 asset, uint256 updatedAt)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
]);

/** ethers v6 在 eth_call revert 時丟的錯誤形狀（CALL_EXCEPTION + data）。 */
const revert = (data: string) => Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data });

const push4Code = (selectors: string[]) => `0x${selectors.map((s) => `63${s.slice(2)}`).join('')}00`;

/** 13 欄（2026-06 版）或 16 欄（2026-09 版）的 positions(id) getter 回傳。 */
function encodePosition(p: { id: bigint; owner: string; asset: string; isLong?: boolean; margin?: bigint; isOpen?: boolean }, extraFields = 2): string {
  const types = ['uint256', 'address', 'bytes32', 'bool', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'int256', 'bool'];
  const values: unknown[] = [p.id, p.owner, p.asset, p.isLong ?? true, 4000n * 10n ** 18n, p.margin ?? 25n * 10n ** 18n, 1n, 1_788_505_970n, 0n, 0n, p.isOpen ?? true];
  for (let i = 0; i < extraFields; i += 1) {
    types.push('uint256');
    values.push(7n);
  }
  return coder.encode(types, values);
}

interface FakeChain {
  code?: string;
  freeMargin?: bigint;
  ids?: bigint[];
  positions?: Record<string, string>;
  balance?: bigint;
  prices?: Record<string, [bigint, bigint]>;
  withdrawRevert?: string;
  closeRevert?: Record<string, string>;
}

function fakeReader(chain: FakeChain): LegacyReader & { calls: string[] } {
  const ALL = Object.values(LEGACY_SELECTORS);
  const calls: string[] = [];
  return {
    calls,
    getCode: async () => chain.code ?? push4Code(ALL),
    call: async ({ to, data }) => {
      const sel = data.slice(0, 10);
      calls.push(sel);
      const arg = `0x${data.slice(10)}`;
      if (to === EXCHANGE.address) {
        switch (sel) {
          case LEGACY_SELECTORS.freeMargin:
            return coder.encode(['uint256'], [chain.freeMargin ?? 0n]);
          case LEGACY_SELECTORS.getUserPositions:
            return coder.encode(['uint256[]'], [chain.ids ?? []]);
          case LEGACY_SELECTORS.positions: {
            const pid = String(coder.decode(['uint256'], arg)[0]);
            return chain.positions?.[pid] ?? encodePosition({ id: 0n, owner: ZeroAddress, asset: zeroPadValue('0x', 32), isOpen: false });
          }
          case LEGACY_SELECTORS.usdc:
            return coder.encode(['address'], [USDC]);
          case LEGACY_SELECTORS.oracle:
            return coder.encode(['address'], [ORACLE]);
          case LEGACY_SELECTORS.maxPriceAge:
            return coder.encode(['uint256'], [21600n]);
          case LEGACY_SELECTORS.withdrawMargin:
            if (chain.withdrawRevert) throw revert(chain.withdrawRevert);
            return '0x';
          case LEGACY_SELECTORS.closePosition: {
            const pid = String(coder.decode(['uint256'], arg)[0]);
            const r = chain.closeRevert?.[pid];
            if (r) throw revert(r);
            return '0x';
          }
          default:
            throw revert('0x');
        }
      }
      if (to === USDC) {
        if (sel === id('balanceOf(address)').slice(0, 10)) return coder.encode(['uint256'], [chain.balance ?? 0n]);
        if (sel === id('decimals()').slice(0, 10)) return coder.encode(['uint8'], [18]);
      }
      if (to === ORACLE) {
        const asset = coder.decode(['bytes32'], arg)[0] as string;
        const p = chain.prices?.[asset.toLowerCase()];
        if (p) return coder.encode(['uint256', 'uint256'], p);
      }
      throw revert('0x');
    },
  };
}

// ----------------------------------------------------------------------

describe('selector probing against old ABIs', () => {
  it('pins the selectors the page relies on', () => {
    expect(LEGACY_SELECTORS).toEqual({
      freeMargin: '0xd8102dd3',
      getUserPositions: '0x2a6bc2dd',
      positions: '0x99fbab88',
      withdrawMargin: '0x0cea7534',
      closePosition: '0xa126d601',
      usdc: '0x3e413bee',
      oracle: '0x7dc0d1d0',
      maxPriceAge: '0x1584410a',
    });
    expect(LEGACY_ERROR_SELECTORS.StalePrice).toBe('0xfa53fd94');
    expect(LEGACY_ERROR_SELECTORS.Unauthorized).toBe('0x82b42900');
    expect(LEGACY_ERROR_SELECTORS.ERC20InsufficientBalance).toBe('0xe450d38c');
  });

  it('skips PUSHn payloads so a 0x63 byte inside data is not read as PUSH4', () => {
    // PUSH32 whose payload starts with 0x63 + a fake selector, then a real PUSH4.
    const fake = `63${'deadbeef'}${'00'.repeat(27)}`;
    const code = `0x7f${fake}63a126d60100`;
    const found = scanPush4Selectors(code);
    expect(found.has('0xa126d601')).toBe(true);
    expect(found.has('0xdeadbeef')).toBe(false);
  });

  it('finds every needed function in the real 2026-06 Base Sepolia exchange bytecode', () => {
    const caps = probeCapabilities(fixtures['baseSepolia_0xEf75ECA6514cE96B18382E921aC6190a0cF8c072']);
    expect(Object.values(caps).every(Boolean)).toBe(true);
  });

  it('reports the oldest Sepolia exchange as lacking maxPriceAge (it never checked price age)', () => {
    const caps = probeCapabilities(fixtures['sepolia_0x00f6cf0113399a7A451c7f85fe094a28092d3e0c']);
    expect(caps).toMatchObject({
      freeMargin: true,
      getUserPositions: true,
      positions: true,
      withdrawMargin: true,
      closePosition: true,
      maxPriceAge: false,
    });
  });
});

describe('decodePositionPrefix', () => {
  it('reads the shared 11-field prefix from both the 13-field and the 16-field struct', () => {
    for (const extra of [2, 5]) {
      const p = decodePositionPrefix(encodePosition({ id: 3n, owner: USER, asset: sETH, isLong: false }, extra));
      expect(p.id).toBe(3n);
      expect(p.owner).toBe(USER);
      expect(p.asset).toBe(sETH);
      expect(p.isLong).toBe(false);
      expect(p.margin).toBe(25n * 10n ** 18n);
      expect(p.isOpen).toBe(true);
    }
  });
});

describe('classifyLegacyRevert — why a pre-check failed', () => {
  it('a recently stale price is a wait, not an operator problem', () => {
    const data = E.encodeErrorResult('StalePrice', [sETH, NOW - 7 * 3600]);
    const b = classifyLegacyRevert(revert(data), NOW);
    expect(b).toMatchObject({ kind: 'stalePrice', needsOperator: false, updatedAt: NOW - 7 * 3600 });
  });

  it('a price nobody has fed for over a week needs the operator', () => {
    const data = E.encodeErrorResult('StalePrice', [sETH, NOW - ABANDONED_PRICE_AGE_SEC - 1]);
    expect(classifyLegacyRevert(revert(data), NOW)).toMatchObject({ kind: 'stalePrice', needsOperator: true });
  });

  it('FeeRouter Unauthorized (fee contract re-pointed to the new exchange) needs the operator', () => {
    expect(classifyLegacyRevert(revert('0x82b42900'), NOW)).toMatchObject({ kind: 'feeRouterRevoked', needsOperator: true });
  });

  it("the exchange's own USDC shortfall is not mistaken for the user's wallet balance", () => {
    const data = E.encodeErrorResult('ERC20InsufficientBalance', [EXCHANGE.address, 1n, 2n]);
    expect(classifyLegacyRevert(revert(data), NOW)).toMatchObject({ kind: 'exchangeUnderfunded', needsOperator: true });
  });

  it('digs revert data out of a JSON-RPC wrapper', () => {
    const wrapped = { message: 'could not coalesce', info: { error: { data: '0x219ce9a3' } } };
    expect(classifyLegacyRevert(wrapped, NOW)).toMatchObject({ kind: 'alreadyClosed', needsOperator: false });
  });

  it('an OpenZeppelin v4 require string is still an underfunded exchange', () => {
    const err = Object.assign(new Error('execution reverted: ERC20: transfer amount exceeds balance'), {});
    expect(classifyLegacyRevert(err, NOW).kind).toBe('exchangeUnderfunded');
  });

  it('anything unrecognised is unknown and routed to the operator, with its selector', () => {
    expect(classifyLegacyRevert(revert('0x12345678'), NOW)).toMatchObject({ kind: 'unknown', needsOperator: true, selector: '0x12345678' });
  });
});

describe('legacyBlockMessage — what the user reads', () => {
  it('uses the catalog sentence for each reason', () => {
    expect(legacyBlockMessage({ kind: 'feeRouterRevoked', needsOperator: true }, NOW)).toBe(t.legacy.block.feeRouterRevoked);
    expect(legacyBlockMessage({ kind: 'exchangeUnderfunded', needsOperator: true }, NOW)).toBe(t.legacy.block.exchangeUnderfunded);
  });

  it('names the price age for a stale price, and switches wording once the feed looks abandoned', () => {
    const recent = legacyBlockMessage({ kind: 'stalePrice', needsOperator: false, updatedAt: NOW - 7 * 3600 }, NOW);
    expect(recent).toContain('7.0');
    expect(recent).not.toBe(legacyBlockMessage({ kind: 'stalePrice', needsOperator: true, updatedAt: NOW - 7 * 3600 }, NOW));
  });

  it('shows the raw selector for unknown failures so support can look it up', () => {
    expect(legacyBlockMessage({ kind: 'unknown', needsOperator: true, selector: '0x12345678' }, NOW)).toContain('0x12345678');
  });
});

describe('planWithdraw', () => {
  it('never offers more than the contract holds', () => {
    expect(planWithdraw(100n, 40n)).toEqual({ amount: 40n, shortfall: 60n });
    expect(planWithdraw(100n, 500n)).toEqual({ amount: 100n, shortfall: 0n });
    expect(planWithdraw(0n, 500n)).toEqual({ amount: 0n, shortfall: 0n });
  });
});

describe('scanLegacyExchange', () => {
  it('a wallet with nothing on the retired contract produces no entry, and no pre-check is sent', async () => {
    const reader = fakeReader({ freeMargin: 0n, ids: [] });
    const scan = await scanLegacyExchange(reader, EXCHANGE, USER, NOW);
    expect(scan.status).toBe('ok');
    expect(scanHasAssets(scan)).toBe(false);
    expect(legacyEntryVisible([scan])).toBe(false);
    expect(reader.calls).not.toContain(LEGACY_SELECTORS.withdrawMargin);
    expect(reader.calls).not.toContain(LEGACY_SELECTORS.closePosition);
  });

  it("ignores closed positions and other people's positions", async () => {
    const reader = fakeReader({
      ids: [0n, 1n],
      positions: {
        0: encodePosition({ id: 0n, owner: USER, asset: sETH, isOpen: false }),
        1: encodePosition({ id: 1n, owner: OTHER, asset: sETH }),
      },
    });
    const scan = await scanLegacyExchange(reader, EXCHANGE, USER, NOW);
    expect(scan.positions).toEqual([]);
    expect(legacyEntryVisible([scan])).toBe(false);
  });

  it('marks each position with its own pre-check result (the real 0xfAEf situation)', async () => {
    const reader = fakeReader({
      freeMargin: 1_595_200_000_000_000n,
      balance: 99_700_000_000_000_000_000n,
      ids: [0n, 1n],
      positions: {
        0: encodePosition({ id: 0n, owner: USER, asset: sAAPL }, 5),
        1: encodePosition({ id: 1n, owner: USER, asset: sETH }, 5),
      },
      prices: { [sAAPL]: [1n, BigInt(NOW - 3600)], [sETH]: [1n, BigInt(NOW - 3600)] },
      closeRevert: { 0: '0x82b42900' },
    });
    const scan: LegacyExchangeScan = await scanLegacyExchange(reader, EXCHANGE, USER, NOW);

    expect(scan.withdraw).toMatchObject({ amount: 1_595_200_000_000_000n, shortfall: 0n, preflight: { ok: true } });
    expect(scan.positions.map((p) => p.close.ok)).toEqual([false, true]);
    const blocked = scan.positions[0].close;
    expect(!blocked.ok && blocked.block.kind).toBe('feeRouterRevoked');
    expect(scan.positions[1].oracleUpdatedAt).toBe(NOW - 3600);
    expect(needsOperator(scan)).toBe(true);
    expect(legacyEntryVisible([scan])).toBe(true);
  });

  it('a withdrawal the contract cannot fully pay is capped and flagged for the operator', async () => {
    const reader = fakeReader({ freeMargin: 1000n, balance: 400n });
    const scan = await scanLegacyExchange(reader, EXCHANGE, USER, NOW);
    expect(scan.withdraw).toMatchObject({ amount: 400n, shortfall: 600n, preflight: { ok: true } });
    expect(needsOperator(scan)).toBe(true);
  });

  it('a withdrawal pre-check failure is carried to the UI instead of a sendable button', async () => {
    const data = E.encodeErrorResult('ERC20InsufficientBalance', [EXCHANGE.address, 1n, 2n]);
    const reader = fakeReader({ freeMargin: 1000n, balance: 1000n, withdrawRevert: data });
    const scan = await scanLegacyExchange(reader, EXCHANGE, USER, NOW);
    expect(scan.withdraw?.preflight.ok).toBe(false);
  });

  it('a contract without the read functions is reported as unsupported, never as "empty"', async () => {
    const reader = fakeReader({ code: push4Code([LEGACY_SELECTORS.freeMargin, LEGACY_SELECTORS.withdrawMargin]) });
    const scan = await scanLegacyExchange(reader, EXCHANGE, USER, NOW);
    expect(scan.status).toBe('unsupported');
    expect(reader.calls).toEqual([]);
  });

  it('no code at the address is reported as such', async () => {
    const reader = fakeReader({ code: '0x' });
    expect((await scanLegacyExchange(reader, EXCHANGE, USER, NOW)).status).toBe('noCode');
  });

  it('an RPC failure is readFailed, not an empty result', async () => {
    const reader: LegacyReader = {
      getCode: async () => push4Code(Object.values(LEGACY_SELECTORS)),
      call: async () => {
        throw new Error('network down');
      },
    };
    const scan = await scanLegacyExchange(reader, EXCHANGE, USER, NOW);
    expect(scan.status).toBe('readFailed');
    expect(legacyEntryVisible([scan])).toBe(false);
  });
});

describe('legacyEntryVisible / settlesAtStalePrice', () => {
  it('shows nothing while loading', () => {
    expect(legacyEntryVisible(null)).toBe(false);
    expect(legacyEntryVisible([])).toBe(false);
  });

  it('warns when a passing close would settle at a price older than the age limit', () => {
    const base = {
      id: 0n, owner: USER, asset: sETH, isLong: true, entryPrice: 0n, margin: 0n, leverage: 1n,
      openedAt: 0n, closedAt: 0n, realizedPnL: 0n, isOpen: true,
    };
    const old = { ...base, oracleUpdatedAt: NOW - 3_000 * 3600, close: { ok: true } as const };
    const fresh = { ...old, oracleUpdatedAt: NOW - 60 };
    const blocked = { ...old, close: { ok: false, block: { kind: 'stalePrice', needsOperator: false } } as const };
    expect(settlesAtStalePrice(old, null, NOW, 21600)).toBe(true);
    expect(settlesAtStalePrice(fresh, null, NOW, 21600)).toBe(false);
    expect(settlesAtStalePrice(blocked, null, NOW, 21600)).toBe(false);
  });
});

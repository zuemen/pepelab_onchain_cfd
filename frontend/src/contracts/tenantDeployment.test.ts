import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, expect, describe } from 'vitest';

import { listTenantIds, loadTenantForBuild } from '../tenant/node';
import { X402_FEE_ROUTER } from './x402';
import * as selected from './deployment';
import { LEGACY_EXCHANGES, legacyExchangesFor } from './legacyExchanges';
import { SESSION_MANAGER_ADDRESS, getSessionManagerAddress } from './sessionManager';
import { DEFAULT_SIGNAL_API_URL } from '../lib/pepefi/signalApiUrl';
import {
  listDeploymentIds,
  RETIRED_PLATFORM_FILE,
  retiredPlatformAddresses,
  dedicatedSignalApiProblem,
  loadTenantDeploymentForBuild,
  PLATFORM_SIGNAL_API_URLS,
  platformSignalApiHosts,
  signalApiHost,
} from './tenantDeployment.node';
import {
  CHAIN_MAP,
  V2_STACK,
  getV2Stack,
  hasV2Stack,
  getAddresses,
  SYNTH_TOKENS,
  getSynthTokens,
} from './addresses';
import {
  SHAREABLE_PATHS,
  resolveDeployment,
  platformAddressSet,
  parseTenantDeployment,
  DEDICATED_CONTRACT_KEYS,
  dedicatedChainAddresses,
  dedicatedAddressEntries,
  deploymentFeatureProblems,
} from './tenantDeployment';

// ----------------------------------------------------------------------

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ZERO = '0x0000000000000000000000000000000000000000';

/** 一組看起來合法、且不在 addresses.ts 裡的位址。 */
const A = (n: number) => `0x${n.toString(16).padStart(40, 'c')}`;

const dedicatedRaw = () => ({
  schemaVersion: 1,
  tenant: 'bank-a',
  kind: 'dedicated',
  chainId: 84532,
  oracleKind: 'guarded',
  contracts: {
    SettlementToken: CHAIN_MAP[84532].MockUSDC,
    Oracle: A(1),
    ESGRegistryV2: A(2),
    KYCRegistry: A(3),
    InsuranceVault: A(4),
    FeeRouter: A(5),
    TraderStake: A(6),
    PerpetualExchange: A(7),
    StrategyRegistry: A(8),
    CopyTracker: A(9),
    AgentSessionManager: A(10),
    AssetVaultV2: A(11),
  } as Record<string, string>,
  shared: ['contracts.SettlementToken'] as string[],
  tokens: { sAAPL: A(20), sGOLD: A(21) } as Record<string, string>,
});

const CHAIN_IDS = [31337, 11155111, 84532];

// ── default 租戶：逐位元不變 ──────────────────────────────────────────────

describe('platform deployment (default tenant)', () => {
  const platform = resolveDeployment(
    parseTenantDeployment({ schemaVersion: 1, tenant: 'default', kind: 'platform' }, 'default')
  );

  it('returns the very same objects addresses.ts returns, for every chain', () => {
    for (const id of [...CHAIN_IDS, 1, 8453, null]) {
      expect(platform.getAddresses(id)).toBe(getAddresses(id));
      expect(platform.getV2Stack(id)).toBe(getV2Stack(id));
      expect(platform.hasV2Stack(id)).toBe(hasV2Stack(id));
      if (id !== null && SYNTH_TOKENS[id]) expect(platform.getSynthTokens(id)).toBe(getSynthTokens(id));
      else expect(platform.getSynthTokens(id)).toEqual({});
      expect(platform.legacyExchangesFor(id)).toEqual(legacyExchangesFor(id));
      expect(platform.x402FeeRouter(id)).toBe(id === null ? undefined : X402_FEE_ROUTER[id]);
      expect(platform.dedicatedSessionManager(id)).toBeUndefined();
    }
    expect(platform.chainMap).toBe(CHAIN_MAP);
  });

  it('is what this build selected (tests run the default tenant)', () => {
    expect(selected.tenantDeployment).toEqual({ schemaVersion: 1, tenant: 'default', kind: 'platform' });
    expect(selected.isPlatformDeployment).toBe(true);
    expect(selected.getAddresses).toBe(getAddresses);
    expect(selected.getV2Stack).toBe(getV2Stack);
    expect(selected.hasV2Stack).toBe(hasV2Stack);
    expect(selected.getSynthTokens).toBe(getSynthTokens);
    expect(selected.legacyExchangesFor).toBe(legacyExchangesFor);
    expect(selected.chainMap).toBe(CHAIN_MAP);
    for (const id of CHAIN_IDS) {
      expect(getSessionManagerAddress(id)).toBe(SESSION_MANAGER_ADDRESS[id]);
    }
    expect(getSessionManagerAddress(null)).toBe(ZERO);
    expect(getSessionManagerAddress(1)).toBe(ZERO);
  });

  // 釘住 default build 連的位址。這份快照變了＝正式站換了合約：那必須是一次刻意的
  // cutover（改 addresses.ts），不能是租戶層的副作用。
  it('pins every address the default build talks to', () => {
    expect({
      chains: Object.fromEntries(CHAIN_IDS.map((id) => [id, selected.getAddresses(id)])),
      v2: Object.fromEntries(CHAIN_IDS.map((id) => [id, selected.getV2Stack(id) ?? null])),
      synthTokens: Object.fromEntries(CHAIN_IDS.map((id) => [id, selected.getSynthTokens(id)])),
      sessionManager: Object.fromEntries(CHAIN_IDS.map((id) => [id, getSessionManagerAddress(id)])),
      x402FeeRouter: Object.fromEntries(CHAIN_IDS.map((id) => [id, selected.x402FeeRouter(id) ?? null])),
      legacy: Object.fromEntries(
        CHAIN_IDS.map((id) => [id, selected.legacyExchangesFor(id).map((e) => e.address)])
      ),
    }).toMatchSnapshot();
  });

  it('the snapshot covers the same data addresses.ts exports', () => {
    expect(selected.getAddresses(84532)).toEqual(CHAIN_MAP[84532]);
    expect(selected.getV2Stack(84532)).toEqual(V2_STACK[84532]);
    expect(selected.legacyExchangesFor(84532)).toHaveLength(
      LEGACY_EXCHANGES.filter((e) => e.chainId === 84532).length
    );
  });
});

// ── 專屬部署 ──────────────────────────────────────────────────────────────

describe('dedicated deployment', () => {
  const dep = parseTenantDeployment(dedicatedRaw(), 'bank-a');
  const r = resolveDeployment(dep);

  it('resolves to the tenant’s own contracts on its chain', () => {
    const a = r.getAddresses(84532)!;
    expect(a.PerpetualExchange).toBe(A(7));
    expect(a.InsuranceVault).toBe(A(4));
    expect(a.FeeRouter).toBe(A(5));
    expect(a.MockOracle).toBe(A(1));
    expect(a.ESGRegistry).toBe(A(2));
    expect(a.KYCRegistry).toBe(A(3));
    expect(a.MockUSDC).toBe(CHAIN_MAP[84532].MockUSDC);
    expect(r.dedicatedSessionManager(84532)).toBe(A(10));
    expect(r.kind).toBe('dedicated');
  });

  it('shares nothing but the settlement token with the platform deployment', () => {
    const platform = platformAddressSet(84532, Object.values(SESSION_MANAGER_ADDRESS));
    const a = r.getAddresses(84532)!;
    for (const [key, value] of Object.entries(a)) {
      if (key === 'MockUSDC' || value === ZERO) continue;
      expect(platform.has(value.toLowerCase()), key).toBe(false);
    }
    const v2 = r.getV2Stack(84532)!;
    for (const value of [v2.GuardedOracle, v2.AssetVaultV2, v2.ESGRegistryV2!, ...Object.values(v2.tokens)]) {
      expect(platform.has(value.toLowerCase())).toBe(false);
    }
  });

  it('leaves platform-only contracts undeployed instead of pointing at the platform’s', () => {
    const a = dedicatedChainAddresses(dep as Extract<typeof dep, { kind: 'dedicated' }>);
    for (const key of [
      'MockUSDT',
      'MockSwapRouter',
      'PepeAMM',
      'PepeToken',
      'PepeClaim',
      'EsgRewardDistributor',
      'PepeIncentives',
      'PepeStaking',
      'AssetVault',
    ] as const) {
      expect(a[key], key).toBe(ZERO);
    }
    expect(Object.keys(a).sort()).toEqual(Object.keys(CHAIN_MAP[84532]).sort());
    expect(r.getSynthTokens(84532)).toEqual({});
  });

  it('knows no other chain — never falls through to the platform’s Sepolia or Anvil', () => {
    for (const id of [31337, 11155111, 8453, 1, null]) {
      expect(r.getAddresses(id)).toBeNull();
      expect(r.getV2Stack(id)).toBeUndefined();
      expect(r.hasV2Stack(id)).toBe(false);
      expect(r.x402FeeRouter(id)).toBeUndefined();
      expect(r.dedicatedSessionManager(id)).toBe(ZERO);
    }
    expect(Object.keys(r.chainMap)).toEqual(['84532']);
  });

  it('exposes the hardened vault stack only when the tenant has a vault', () => {
    expect(r.hasV2Stack(84532)).toBe(true);
    expect(r.getV2Stack(84532)).toEqual({
      GuardedOracle: A(1),
      AssetVaultV2: A(11),
      ESGRegistryV2: A(2),
      tokens: { sAAPL: A(20), sGOLD: A(21) },
    });

    const raw = dedicatedRaw();
    delete raw.contracts.AssetVaultV2;
    const noVault = resolveDeployment(parseTenantDeployment({ ...raw, tokens: undefined }, 'bank-a'));
    expect(noVault.hasV2Stack(84532)).toBe(false);
    expect(noVault.getV2Stack(84532)).toBeUndefined();
    expect(noVault.getAddresses(84532)!.PerpetualExchange).toBe(A(7));
  });

  it('has no legacy exchanges: /legacy belongs to the platform deployment only', () => {
    for (const id of [...CHAIN_IDS, null]) expect(r.legacyExchangesFor(id)).toEqual([]);
    expect(legacyExchangesFor(84532).length).toBeGreaterThan(0);
  });

  it('x402 router is the tenant’s own or absent — never the platform’s', () => {
    expect(r.x402FeeRouter(84532)).toBeUndefined();
    const raw = dedicatedRaw();
    raw.contracts.X402FeeRouter = A(30);
    expect(resolveDeployment(parseTenantDeployment(raw, 'bank-a')).x402FeeRouter(84532)).toBe(A(30));
  });
});

// ── 登記檔驗證 ────────────────────────────────────────────────────────────

describe('deployment registry validation', () => {
  const parse = (mutate: (raw: ReturnType<typeof dedicatedRaw>) => void, tenant = 'bank-a') => {
    const raw = dedicatedRaw();
    mutate(raw);
    return () => parseTenantDeployment(raw, tenant);
  };

  it('accepts the fixture', () => {
    expect(parse(() => {})).not.toThrow();
  });

  it('refuses any platform address other than the settlement token (tenant isolation)', () => {
    const live = CHAIN_MAP[84532];
    const v2 = V2_STACK[84532];
    const cases: [string, string][] = [
      ['PerpetualExchange', live.PerpetualExchange],
      ['InsuranceVault', live.InsuranceVault],
      ['FeeRouter', live.FeeRouter],
      ['TraderStake', live.TraderStake],
      ['CopyTracker', live.CopyTracker],
      ['KYCRegistry', live.KYCRegistry],
      ['Oracle', live.MockOracle],
      ['Oracle', v2.GuardedOracle],
      ['AssetVaultV2', v2.AssetVaultV2],
      ['AssetVaultV2', live.AssetVault],
      ['ESGRegistryV2', v2.ESGRegistryV2!],
      ['X402FeeRouter', X402_FEE_ROUTER[84532]],
      ['PerpetualExchange', LEGACY_EXCHANGES.find((e) => e.chainId === 84532)!.address],
    ];
    for (const [key, addr] of cases) {
      expect(parse((r) => { r.contracts[key] = addr; }), `${key}=${addr}`).toThrow(
        /breaks tenant isolation[\s\S]*is an address of the platform deployment/
      );
      // 大小寫不同也是同一個位址。
      expect(parse((r) => { r.contracts[key] = addr.toLowerCase(); }), key).toThrow(/breaks tenant isolation/);
    }
    expect(parse((r) => { r.tokens.sAAPL = v2.tokens.sAAPL!; })).toThrow(/tokens\.sAAPL .* platform deployment/);
    expect(parse((r) => { r.tokens.sAAPL = SYNTH_TOKENS[84532].sAAPL!; })).toThrow(/breaks tenant isolation/);
  });

  it('refuses the platform’s AgentSessionManager when the caller supplies that table', () => {
    const raw = dedicatedRaw();
    raw.contracts.AgentSessionManager = SESSION_MANAGER_ADDRESS[84532];
    expect(() => parseTenantDeployment(raw, 'bank-a', Object.values(SESSION_MANAGER_ADDRESS))).toThrow(
      /contracts\.AgentSessionManager .* platform deployment/
    );
  });

  it('shares the settlement token only when "shared" declares it, and only the platform’s token', () => {
    expect(SHAREABLE_PATHS).toEqual(['contracts.SettlementToken']);
    // 沒有宣告：平台的結算幣就是平台的位址。
    expect(parse((r) => { r.shared = []; })).toThrow(
      /contracts\.SettlementToken .* platform deployment[\s\S]*only when "shared" declares it/
    );
    // 宣告了，但值是平台的另一顆合約（18 位 ERC20 的保險金份額）。
    expect(parse((r) => { r.contracts.SettlementToken = CHAIN_MAP[84532].InsuranceVault; })).toThrow(
      /declared shared but is not the platform's settlement token/
    );
    // 宣告了，但值是任意位址。
    expect(parse((r) => { r.contracts.SettlementToken = A(50); })).toThrow(/declared shared but is not the platform's settlement token/);
    // 租戶自己的代幣：不宣告、也不在平台位址裡 → 可以。
    expect(parse((r) => { r.contracts.SettlementToken = A(50); r.shared = []; })).not.toThrow();
    // 白名單以外的欄位、缺少 shared、重複宣告。
    expect(parse((r) => { r.shared = ['contracts.SettlementToken', 'contracts.PerpetualExchange']; })).toThrow(
      /invalid deployment registry/
    );
    expect(parse((r) => { delete (r as Partial<typeof r>).shared; })).toThrow(/invalid deployment registry/);
    expect(parse((r) => { r.shared = ['contracts.SettlementToken', 'contracts.SettlementToken']; })).toThrow(
      /shared lists the same field twice/
    );
  });

  it('refuses the platform’s retired contracts (machine-readable list, read at build time)', () => {
    const retired = retiredPlatformAddresses(FRONTEND_ROOT);
    expect(retired.length).toBeGreaterThan(30);
    // 審查 F2：只寫在 sessionManager.ts 註解裡的舊 AgentSessionManager。
    expect(retired.map((a) => a.toLowerCase())).toContain('0x4e7cc1b79b72ab72531a6c790e14304370f70764');
    for (const addr of retired) {
      const raw = dedicatedRaw();
      raw.contracts.AgentSessionManager = addr;
      expect(() => parseTenantDeployment(raw, 'bank-a', retired), addr).toThrow(/breaks tenant isolation/);
    }
  });

  it('the build-time loader applies the retired list (a registry reusing a retired contract fails the build)', () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tenant-root-'));
    fs.mkdirSync(path.join(root, 'src', 'contracts', 'deployments'), { recursive: true });
    fs.copyFileSync(path.join(FRONTEND_ROOT, RETIRED_PLATFORM_FILE), path.join(root, RETIRED_PLATFORM_FILE));
    const raw = dedicatedRaw();
    fs.writeFileSync(path.join(root, 'src', 'contracts', 'deployments', 'bank-a.json'), JSON.stringify(raw));
    expect(loadTenantDeploymentForBuild(root, 'bank-a').deployment.kind).toBe('dedicated');
    raw.contracts.AgentSessionManager = '0x4E7cC1B79B72ab72531a6C790e14304370f70764';
    fs.writeFileSync(path.join(root, 'src', 'contracts', 'deployments', 'bank-a.json'), JSON.stringify(raw));
    expect(() => loadTenantDeploymentForBuild(root, 'bank-a')).toThrow(
      /contracts\.AgentSessionManager .* platform deployment/
    );
  });

  it('enumerates every address in the registry, not a hand-written field list', () => {
    const dep = parseTenantDeployment(dedicatedRaw(), 'bank-a');
    if (dep.kind !== 'dedicated') throw new Error('fixture');
    const paths = dedicatedAddressEntries(dep).map(([p]) => p).sort();
    expect(paths).toEqual(
      [...Object.keys(dedicatedRaw().contracts).map((k) => `contracts.${k}`), 'tokens.sAAPL', 'tokens.sGOLD'].sort()
    );
  });

  it('refuses two contracts of one tenant at the same address', () => {
    expect(parse((r) => { r.contracts.FeeRouter = r.contracts.InsuranceVault; })).toThrow(
      /contracts\.FeeRouter and contracts\.InsuranceVault are the same address/
    );
    expect(parse((r) => { r.tokens.sGOLD = r.tokens.sAAPL; })).toThrow(/are the same address/);
    expect(parse((r) => { r.tokens.sGOLD = r.contracts.PerpetualExchange.toUpperCase().replace('0X', '0x'); })).toThrow(
      /are the same address/
    );
  });

  it('refuses malformed, zero and missing addresses', () => {
    expect(parse((r) => { r.contracts.PerpetualExchange = ZERO; })).toThrow(/must not be the zero address/);
    expect(parse((r) => { r.contracts.PerpetualExchange = '0x1234'; })).toThrow(/20-byte hex address/);
    expect(parse((r) => { r.contracts.PerpetualExchange = 'https://example.com'; })).toThrow(/20-byte hex address/);
    for (const key of DEDICATED_CONTRACT_KEYS) {
      expect(parse((r) => { delete r.contracts[key]; }), key).toThrow(/invalid deployment registry/);
    }
    expect(parse((r) => { delete r.contracts.SettlementToken; })).toThrow(/invalid deployment registry/);
  });

  it('refuses unknown fields, unknown assets and unsupported chains', () => {
    expect(parse((r) => { r.contracts.Backdoor = A(40); })).toThrow(/invalid deployment registry/);
    expect(parse((r) => { (r as Record<string, unknown>).rpcUrl = 'x'; })).toThrow(/invalid deployment registry/);
    expect(parse((r) => { r.tokens.sDOGE = A(41); })).toThrow(/invalid deployment registry/);
    expect(parse((r) => { r.chainId = 8453; })).toThrow(/invalid deployment registry/);
    expect(parse((r) => { r.chainId = 11155111; })).toThrow(/invalid deployment registry/);
    expect(parse((r) => { r.oracleKind = 'chainlink'; })).toThrow(/invalid deployment registry/);
    expect(parse((r) => { r.schemaVersion = 2; })).toThrow(/invalid deployment registry/);
  });

  it('keeps vault and tokens consistent', () => {
    expect(parse((r) => { delete r.contracts.AssetVaultV2; })).toThrow(/tokens are listed but contracts\.AssetVaultV2 is missing/);
    expect(parse((r) => { r.tokens = {}; })).toThrow(/AssetVaultV2 is set but tokens is empty/);
    expect(parse((r) => { r.oracleKind = 'mock'; })).toThrow(/AssetVaultV2 requires oracleKind "guarded"/);
  });

  it('binds the file to the selected tenant', () => {
    expect(parse(() => {}, 'bank-b')).toThrow(/does not match the selected tenant "bank-b"/);
    expect(parse((r) => { r.tenant = 'default'; }, 'default')).toThrow(/default tenant is the platform deployment/);
    expect(parse((r) => { r.tenant = 'Bank A'; }, 'Bank A')).toThrow(/invalid deployment registry/);
  });

  it('a non-default tenant on the platform contracts must say why', () => {
    expect(() => parseTenantDeployment({ schemaVersion: 1, tenant: 'bank-a', kind: 'platform' }, 'bank-a')).toThrow(
      /kind "platform" without a note/
    );
    expect(
      parseTenantDeployment({ schemaVersion: 1, tenant: 'bank-a', kind: 'platform', note: 'demo only' }, 'bank-a').kind
    ).toBe('platform');
    expect(() =>
      parseTenantDeployment({ schemaVersion: 1, tenant: 'bank-a', kind: 'platform', note: 'x', contracts: {} }, 'bank-a')
    ).toThrow(/invalid deployment registry/);
    expect(() => parseTenantDeployment({ schemaVersion: 1, tenant: 'bank-a', kind: 'shared' }, 'bank-a')).toThrow(
      /invalid deployment registry/
    );
  });
});

// ── checked-in 的登記檔 ────────────────────────────────────────────────────

describe('checked-in deployment registries', () => {
  it('every tenant has one, and every one belongs to a tenant (no silent fallback)', () => {
    expect(listDeploymentIds(FRONTEND_ROOT)).toEqual(listTenantIds(FRONTEND_ROOT));
  });

  it('all of them validate, against the features their tenant authorizes', () => {
    for (const id of listDeploymentIds(FRONTEND_ROOT)) {
      const { features } = loadTenantForBuild(FRONTEND_ROOT, id).config;
      const { deployment } = loadTenantDeploymentForBuild(FRONTEND_ROOT, id, features);
      expect(deployment.tenant).toBe(id);
    }
  });

  it('a dedicated tenant cannot authorize features only the platform contracts serve', () => {
    const dep = parseTenantDeployment(dedicatedRaw(), 'bank-a');
    const off = { allowed: false };
    const on = { allowed: true };
    const base = { gamefi: off, pepeRewards: off, copyTrading: on, showLeverage: on, showPerpetuals: on };
    expect(deploymentFeatureProblems(dep, base)).toEqual([]);
    expect(deploymentFeatureProblems(dep, { ...base, gamefi: on })).toHaveLength(1);
    expect(deploymentFeatureProblems(dep, { ...base, gamefi: on, pepeRewards: on }).join('\n')).toMatch(
      /features\.gamefi\.allowed[\s\S]*features\.pepeRewards\.allowed/
    );
    // 平台部署有那些合約：default 租戶五個旗標都 allowed，不受影響。
    const platform = parseTenantDeployment({ schemaVersion: 1, tenant: 'default', kind: 'platform' }, 'default');
    expect(deploymentFeatureProblems(platform, { ...base, gamefi: on, pepeRewards: on })).toEqual([]);
  });

  it('default is the platform deployment; the demo tenant says it shares it', () => {
    expect(loadTenantDeploymentForBuild(FRONTEND_ROOT, 'default').deployment).toEqual({
      schemaVersion: 1,
      tenant: 'default',
      kind: 'platform',
    });
    const demo = loadTenantDeploymentForBuild(FRONTEND_ROOT, 'demo-bank').deployment;
    expect(demo.kind).toBe('platform');
    expect(demo.kind === 'platform' && demo.note).toBeTruthy();
  });

  it('a dedicated tenant must name its own signal-api; platform tenants are unchanged (F4)', () => {
    const dedicated = parseTenantDeployment(dedicatedRaw(), 'bank-a');
    expect(dedicatedSignalApiProblem(dedicated, undefined)).toMatch(/set VITE_SIGNAL_API_URL/);
    expect(dedicatedSignalApiProblem(dedicated, '')).toMatch(/set VITE_SIGNAL_API_URL/);
    expect(dedicatedSignalApiProblem(dedicated, '   ')).toMatch(/set VITE_SIGNAL_API_URL/);
    expect(dedicatedSignalApiProblem(dedicated, DEFAULT_SIGNAL_API_URL)).toMatch(/points at the platform/);
    expect(dedicatedSignalApiProblem(dedicated, `${DEFAULT_SIGNAL_API_URL}/`)).toMatch(/points at the platform/);
    expect(dedicatedSignalApiProblem(dedicated, 'https://signal.bank-a.example')).toBeNull();
    for (const id of ['default', 'demo-bank']) {
      const platform = loadTenantDeploymentForBuild(FRONTEND_ROOT, id).deployment;
      expect(dedicatedSignalApiProblem(platform, undefined), id).toBeNull();
      expect(dedicatedSignalApiProblem(platform, DEFAULT_SIGNAL_API_URL), id).toBeNull();
    }
    // vite.config.ts 真的在載入部署登記之後呼叫它，並在有問題時丟錯。
    const vite = fs.readFileSync(path.join(FRONTEND_ROOT, 'vite.config.ts'), 'utf8');
    expect(vite).toMatch(/dedicatedSignalApiProblem\(\s*deployment\.deployment,\s*envOf\('VITE_SIGNAL_API_URL'\)\s*\)/);
    expect(vite).toMatch(/if \(signalApiProblem\) throw new Error/);
  });

  it('compares the signal-api by parsed host, not by string (review A3)', () => {
    const dedicated = parseTenantDeployment(dedicatedRaw(), 'bank-a');
    const host = new URL(DEFAULT_SIGNAL_API_URL).host;
    for (const variant of [
      `https://${host.toUpperCase()}`,
      `HTTPS://${host}`,
      `https://${host}:443`,
      `https://${host}:8443`,
      `https://${host}/?t=1`,
      `https://${host}/#x`,
      `https://${host}/`,
      `https://${host}//`,
      `https://${host}/x/..`,
      `https://${host}.`,
      `https://${host}./`,
      `https://x@${host}`,
      `https://x:y@${host}/path`,
      `  https://${host}  `,
      `http://${host}`,
    ]) {
      expect(dedicatedSignalApiProblem(dedicated, variant), variant).toMatch(/points at the platform/);
    }
    expect(dedicatedSignalApiProblem(dedicated, 'not a url')).toMatch(/not a valid URL/);
    expect(dedicatedSignalApiProblem(dedicated, `https://${host}.evil.example`)).toBeNull();
    expect(dedicatedSignalApiProblem(dedicated, 'https://signal.bank-a.example/?t=1')).toBeNull();
    expect(signalApiHost(`https://X@${host.toUpperCase()}.:443/a?b#c`)).toBe(host);
  });

  it('the platform signal-api host set covers the SDK constant (agent/sdk/src/signalApi.ts)', () => {
    const sdk = fs.readFileSync(path.join(FRONTEND_ROOT, '..', 'agent', 'sdk', 'src', 'signalApi.ts'), 'utf8');
    const m = /export const SIGNAL_API_TESTNET_URL\s*=\s*"([^"]+)"/.exec(sdk);
    expect(m, 'SIGNAL_API_TESTNET_URL not found').not.toBeNull();
    expect(platformSignalApiHosts().has(signalApiHost(m![1])!)).toBe(true);
    expect(PLATFORM_SIGNAL_API_URLS).toContain(DEFAULT_SIGNAL_API_URL);
  });

  it('the agent monitor judges a dedicated tenant’s staleness by timestamp, the platform’s by isStale() (F6)', () => {
    const page = fs.readFileSync(path.join(FRONTEND_ROOT, 'src', 'pages', 'pepefi', 'AgentMonitorPage.tsx'), 'utf8');
    expect(page).toMatch(/oracleRowStale\(\{\s*platform: isPlatformDeployment,/);
    expect(page).not.toMatch(/stale = \(await contracts\.oracle\.isStale/);
  });

  it('a tenant without a registry fails the build instead of falling back', () => {
    expect(() => loadTenantDeploymentForBuild(FRONTEND_ROOT, 'no-such-bank')).toThrow(
      /no deployment registry for tenant "no-such-bank"[\s\S]*never falls back/
    );
  });

  it('holds no address-shaped value outside a dedicated registry’s contracts/tokens', () => {
    // 租戶設定檔（src/tenant/tenants）仍然沒有任何位址：位址只在部署登記裡。
    const tenantsDir = path.join(FRONTEND_ROOT, 'src', 'tenant', 'tenants');
    for (const f of fs.readdirSync(tenantsDir)) {
      expect(fs.readFileSync(path.join(tenantsDir, f), 'utf8'), f).not.toMatch(/0x[0-9a-fA-F]{40}/);
    }
  });
});

// ── 原始碼掃描：依租戶而不同的位址只能從 deployment.ts 拿 ──────────────────

// 這組測試同步掃整個檔案樹，Windows 開發機在負載下要 3～17 秒。vitest 2 不對同步測試計時，
// vitest 4 會在同步測試結束後比對耗時、超過 testTimeout（預設 5 秒）就判失敗，所以在這裡明確給
// 60 秒上限：不讓機器負載決定結果，真正卡住時仍會失敗。
const SCAN = { timeout: 60_000 };
describe('tenant-sensitive addresses are only read through src/contracts/deployment', SCAN, () => {
  const SRC = path.join(FRONTEND_ROOT, 'src');
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
    });
  // src/contracts 本身是登記與解析層；其餘所有檔案都是使用者。
  const files = walk(SRC).filter((p) => !p.startsWith(path.join(SRC, 'contracts') + path.sep));
  const importsOf = (src: string, mod: RegExp): string[] =>
    [...src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g)]
      .filter((m) => mod.test(m[2]))
      .flatMap((m) => m[1].split(',').map((s) => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]))
      .filter(Boolean);

  it('scans a meaningful number of files', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('nothing imports the platform getters or tables from addresses.ts', () => {
    const banned = new Set([
      'getAddresses',
      'getV2Stack',
      'hasV2Stack',
      'getSynthTokens',
      'CHAIN_MAP',
      'V2_STACK',
      'SYNTH_TOKENS',
    ]);
    const offenders = files.flatMap((f) =>
      importsOf(fs.readFileSync(f, 'utf8'), /contracts\/addresses$/)
        .filter((name) => banned.has(name))
        .map((name) => `${path.relative(SRC, f)}: ${name}`)
    );
    expect(offenders).toEqual([]);
  });

  it('nothing imports the x402 router table or the legacy table directly', () => {
    const offenders = files.flatMap((f) => {
      const src = fs.readFileSync(f, 'utf8');
      return [
        ...importsOf(src, /contracts\/x402$/),
        ...importsOf(src, /contracts\/legacyExchanges$/).filter((n) => n !== 'LegacyExchange'),
        ...importsOf(src, /contracts\/selectedDeployment$/),
        ...importsOf(src, /contracts\/sessionManager$/).filter((n) => n === 'SESSION_MANAGER_ADDRESS'),
      ].map((name) => `${path.relative(SRC, f)}: ${name}`);
    });
    expect(offenders).toEqual([]);
  });

  it('the hooks that build contracts use the tenant-aware module', () => {
    for (const f of ['hooks/useContracts.ts', 'hooks/useV2Contracts.ts', 'hooks/useLivePrices.ts', 'hooks/useLegacyAssets.ts']) {
      expect(fs.readFileSync(path.join(SRC, f), 'utf8'), f).toMatch(/from 'src\/contracts\/deployment'/);
    }
  });
});

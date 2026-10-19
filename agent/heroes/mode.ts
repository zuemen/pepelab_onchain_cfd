// 回放跑在哪條鏈：預設本機 Anvil（31337），公開鏈模式只允許 Base Sepolia（84532，#344）。
// 這裡只有不碰鏈的判斷：參數怎麼讀、chainId 對不對、執行前的確認字句。

export const LOCAL_CHAIN_ID = 31337n;
export const PUBLIC_CHAIN_ID = 84532n;

/** 公開鏈模式執行前要一字不差輸入的確認字句。 */
export const CONFIRM_PHRASE = "replay on 84532";

export type ModeKind = "local" | "public";

export interface ReplayArgs {
  mode: ModeKind;
  schedulePath: string;
  addressesPath: string;
  outPath: string;
  /** 公開鏈模式：每跑完一天寫一次的進度檔（中斷續跑用）。 */
  progressPath: string | null;
  /** 公開鏈模式：交易者、跟隨者、造市帳號的金鑰檔（被 git 忽略）。 */
  keystorePath: string | null;
  /** 公開鏈模式：部署者的 Foundry keystore 名稱（~/.foundry/keystores/<name>）。 */
  deployerAccount: string | null;
  /** fork 演練專用：在 anvil fork 上假冒部署者，不需要私鑰。真實鏈一律拒絕。 */
  impersonate: string | null;
}

export const USAGE = [
  "usage: tsx heroes/replay.ts <schedule.json> <addresses.json> <events.json>",
  "       tsx heroes/replay.ts --public-chain <schedule.json> <addresses.json> <events.json>",
  "            --progress <progress.json> --keystore <keys.json>",
  "            (--deployer-account <foundry keystore name> | --impersonate-deployer <address>)",
].join("\n");

/** 讀命令列。不合法就丟錯（訊息附 USAGE），不會猜。 */
export function parseArgs(argv: readonly string[]): ReplayArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const VALUED = new Set(["--progress", "--keystore", "--deployer-account", "--impersonate-deployer"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--public-chain") flags[a] = true;
    else if (VALUED.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value\n${USAGE}`);
      flags[a] = v;
    } else if (a.startsWith("--")) throw new Error(`unknown flag ${a}\n${USAGE}`);
    else positional.push(a);
  }
  if (positional.length !== 3) throw new Error(USAGE);
  const [schedulePath, addressesPath, outPath] = positional;
  const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : null);
  const args: ReplayArgs = {
    mode: flags["--public-chain"] ? "public" : "local",
    schedulePath, addressesPath, outPath,
    progressPath: str("--progress"),
    keystorePath: str("--keystore"),
    deployerAccount: str("--deployer-account"),
    impersonate: str("--impersonate-deployer"),
  };
  if (args.mode === "local") {
    const stray = ["--progress", "--keystore", "--deployer-account", "--impersonate-deployer"].filter((k) => k in flags);
    if (stray.length) throw new Error(`${stray.join(", ")} only apply with --public-chain\n${USAGE}`);
  } else {
    if (!args.progressPath) throw new Error(`--public-chain needs --progress\n${USAGE}`);
    if (!args.keystorePath) throw new Error(`--public-chain needs --keystore\n${USAGE}`);
    if (!args.deployerAccount === !args.impersonate) {
      throw new Error(`--public-chain needs exactly one of --deployer-account / --impersonate-deployer\n${USAGE}`);
    }
  }
  return args;
}

/** 本機模式只接受 31337、公開鏈模式只接受 84532。其他一律拒絕。 */
export function assertChain(mode: ModeKind, chainId: bigint): void {
  const want = mode === "local" ? LOCAL_CHAIN_ID : PUBLIC_CHAIN_ID;
  if (chainId === want) return;
  if (mode === "local") {
    throw new Error(`refusing to replay on chainId ${chainId}: local Anvil (31337) only; Base Sepolia needs --public-chain`);
  }
  throw new Error(`refusing to replay on chainId ${chainId}: --public-chain is Base Sepolia (84532) only`);
}

/**
 * 假冒部署者（anvil_impersonateAccount）只在 anvil fork 上可行，也只該在那裡用：節點要自稱 anvil，
 * 而且 chainId 已經通過 assertChain。真的 Base Sepolia 節點不會自稱 anvil，就算有人帶了旗標也會被擋。
 */
export function assertImpersonationAllowed(clientVersion: string): void {
  if (!/^anvil\//i.test(clientVersion)) {
    throw new Error(`--impersonate-deployer is for an anvil fork rehearsal only; this node is "${clientVersion}"`);
  }
}

/** 公開鏈模式的 RPC 必須明確指定；公開的 sepolia.base.org 會警告（eth_getLogs 一次 1,000 區塊、曾 nonce 錯亂）。 */
export function rpcWarning(rpc: string): string | null {
  if (/sepolia\.base\.org/i.test(rpc)) {
    return "HEROES_RPC_URL is the public sepolia.base.org: it caps eth_getLogs at 1,000 blocks and mixed up nonces in the 10/10 cutover; use an Infura/Alchemy endpoint";
  }
  return null;
}

/** 確認字句：去掉頭尾空白後要一字不差。 */
export const confirmed = (answer: string): boolean => answer.trim() === CONFIRM_PHRASE;

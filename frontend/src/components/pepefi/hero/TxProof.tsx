import type { BrowserProvider } from 'ethers';

import { useState } from 'react';

import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';

import { t, interpolate } from 'src/locales';
import { MONO } from 'src/components/pepefi/brandKit';
import { explorerTx } from 'src/lib/pepefi/explorer';

// ----------------------------------------------------------------------
// 交易證明（issue #309）：一筆交易雜湊。有區塊瀏覽器的鏈直接連過去；本機鏈沒有，點了就向節點
// 讀這筆交易的收據——畫面上的「交易證明」是鏈回的答案，不是資料檔自己說的。
// 部位紀錄（開倉、平倉）與策略歷史（發布交易）共用。

const shortHash = (hash: string) => `${hash.slice(0, 10)}…${hash.slice(-6)}`;

type Proof =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ok'; block: number; time: number | null; success: boolean; logs: number };

interface Props {
  label: string;
  hash: string;
  provider: BrowserProvider | null;
  chainId: number | null;
}

export default function TxProof({ label, hash, provider, chainId }: Props) {
  const [proof, setProof] = useState<Proof | null>(null);
  const L = t.traderProfile.hero;
  const href = explorerTx(hash, chainId);

  const load = async () => {
    if (!provider) return setProof({ state: 'failed' });
    setProof({ state: 'loading' });
    try {
      const receipt = await provider.getTransactionReceipt(hash);
      if (!receipt) return setProof({ state: 'failed' });
      const block = await provider.getBlock(receipt.blockNumber);
      return setProof({
        state: 'ok',
        block: receipt.blockNumber,
        time: block?.timestamp ?? null,
        success: receipt.status === 1,
        logs: receipt.logs.length,
      });
    } catch {
      return setProof({ state: 'failed' });
    }
  };

  return (
    <Box sx={{ lineHeight: 1.4 }}>
      <Typography variant="caption" color="text.secondary">{label} </Typography>
      {href ? (
        <Link href={href} target="_blank" rel="noopener noreferrer" variant="caption" sx={{ fontFamily: MONO }}>
          {shortHash(hash)}
        </Link>
      ) : (
        <Link component="button" type="button" variant="caption" onClick={() => void load()} sx={{ fontFamily: MONO }}>
          {shortHash(hash)}
        </Link>
      )}
      {proof?.state === 'loading' && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{L.proofLoading}</Typography>
      )}
      {proof?.state === 'failed' && (
        <Typography variant="caption" color="warning.main" sx={{ display: 'block' }}>{L.proofFailed}</Typography>
      )}
      {proof?.state === 'ok' && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontFamily: MONO }}>
          {interpolate(L.proofBlock, { block: proof.block })}
          {' · '}
          {interpolate(L.proofTime, { time: proof.time === null ? '—' : new Date(proof.time * 1000).toISOString().replace('.000Z', 'Z') })}
          {' · '}
          {interpolate(L.proofStatus, { status: proof.success ? L.proofSuccess : L.proofReverted })}
          {' · '}
          {interpolate(L.proofLogs, { count: proof.logs })}
        </Typography>
      )}
    </Box>
  );
}

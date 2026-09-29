import type { ButtonProps } from '@mui/material/Button';
import type { Eip1193Request } from 'src/lib/pepefi/switchChain';

import { useState } from 'react';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';

import { t } from 'src/locales';
import { switchToBaseSepolia } from 'src/lib/pepefi/switchChain';

// ----------------------------------------------------------------------

/**
 * 「切換到 Base Sepolia」。錢包切鏈後 useWallet 的 chainChanged 監聽會重新載入頁面，
 * 所以這裡只需要處理失敗：使用者拒絕或錢包不支援時把原因寫在按鈕旁邊。
 */
export function SwitchChainButton(props: ButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const eth = typeof window !== 'undefined' ? window.ethereum : undefined;
  if (!eth) return null;

  const onClick = async () => {
    setBusy(true);
    setError(null);
    try {
      await switchToBaseSepolia((eth as unknown as { request: Eip1193Request }).request.bind(eth));
    } catch (e) {
      const code = (e as { code?: number }).code;
      setError(code === 4001 ? t.common.switchChain.rejected : t.common.switchChain.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
      <Button size="small" variant="contained" color="warning" disabled={busy} onClick={() => void onClick()} {...props}>
        {busy ? t.common.switchChain.switching : t.common.switchChain.cta}
      </Button>
      {error && (
        <Box component="span" role="alert" sx={{ fontSize: 12 }}>
          {error}
        </Box>
      )}
    </Box>
  );
}

import { useState, useEffect } from 'react';
import type { Contract } from 'ethers';
import { t, interpolate } from 'src/locales';
import { prettyError } from 'src/lib/pepefi/errorMessages';
import {
  toKycReceipt,
  kycSubmitArgs,
  loadKycReceipts,
  promoteKycReceipt,
  buildKycSubmission,
  savePendingKycReceipt,
  clearPendingKycReceipt,
  type KycReceipt,
  type ReceiptLocation,
  type StoredKycReceipts,
} from 'src/lib/pepefi/kycCommitment';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import FormControl from '@mui/material/FormControl';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import InputLabel from '@mui/material/InputLabel';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';

import { Iconify } from 'src/components/iconify';

const COUNTRIES = [
  'TW', 'US', 'JP', 'KR', 'HK', 'SG', 'GB', 'DE', 'FR', 'CA',
  'AU', 'NZ', 'CH', 'SE', 'NL', 'BE', 'IT', 'ES', 'PT', 'AT',
  'DK', 'NO', 'FI', 'IE', 'CN', 'IN', 'BR', 'MX', 'TH', 'MY',
  'ID', 'PH', 'VN', 'PL', 'CZ', 'IL', 'ZA', 'AE', 'SA', 'OTHER',
]

/** ISO 兩碼是資料，右邊的國名是顯示字串，所以只有後者住在 catalog。 */
const COUNTRY_NAMES: Record<string, string> = t.kyc.country

interface Props {
  isOpen:      boolean;
  onClose:     () => void;
  onSuccess:   () => void;
  kycRegistry: Contract | null;
  /**
   * 這個地址已經送出過申請、正在等審核。
   *
   * KYCRegistry 改成審核制之後，「還沒通過」有兩種完全不同的狀態，重送表單對
   * `pending` 的使用者沒有任何幫助（只是再燒一次 gas），所以送出鍵要關掉。
   */
  isPending?:  boolean;
}

type TxResp = { wait(): Promise<unknown>; hash: string }
const asTx = (tx: unknown): TxResp => tx as TxResp

/** 收據在 localStorage 的定位：鏈、KYCRegistry 位址、使用者位址。拿不到就回 null。 */
async function receiptLocation(kycRegistry: Contract): Promise<ReceiptLocation | null> {
  try {
    const runner = kycRegistry.runner as {
      getAddress?: () => Promise<string>
      provider?: { getNetwork?: () => Promise<{ chainId: bigint }> }
    } | null;
    if (!runner?.getAddress) return null;
    const [user, net, registry] = await Promise.all([
      runner.getAddress(),
      runner.provider?.getNetwork ? runner.provider.getNetwork() : Promise.resolve(null),
      kycRegistry.getAddress(),
    ]);
    return { chainId: net ? Number(net.chainId) : null, registry, user };
  } catch {
    return null;
  }
}

/** 收據的三個欄位：salt 與兩個雜湊，唯讀、可選取複製。 */
function ReceiptFields({ r }: { r: Pick<KycReceipt, 'salt' | 'nameHash' | 'nationalityHash' | 'txHash'> }) {
  const rows: Array<[string, string]> = [
    [t.kyc.receipt.salt, r.salt],
    [t.kyc.receipt.nameHash, r.nameHash],
    [t.kyc.receipt.nationalityHash, r.nationalityHash],
  ];
  if (r.txHash) rows.push([t.kyc.receipt.txHash, r.txHash]);
  return (
    <>
      {rows.map(([label, value]) => (
        <TextField
          key={label}
          label={label}
          value={value}
          size="small"
          fullWidth
          sx={{ mb: 1, '& input': { fontFamily: 'monospace', fontSize: 11 } }}
          slotProps={{ input: { readOnly: true }, inputLabel: { shrink: true } }}
        />
      ))}
    </>
  );
}

export default function KYCModal({ isOpen, onClose, onSuccess, kycRegistry, isPending = false }: Props) {
  const [fullName,    setFullName]    = useState('');
  const [nationality, setNationality] = useState('TW');
  const [busy,        setBusy]        = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  /** 這一輪送出成功 → 停在「已送出、待審核」畫面，不要直接關掉讓人以為過了。 */
  const [submitted,   setSubmitted]   = useState(false);
  /** 這一輪送出的 salt 與雜湊——只在使用者端，送出後顯示給使用者自行保存。 */
  const [receipt,     setReceipt]     = useState<(KycReceipt & { normalizedName: string; normalizedNationality: string }) | null>(null);
  const [receiptSaved, setReceiptSaved] = useState(false);
  /** 交易已送出（有 hash）但確認失敗：收據要保留，請使用者自行到瀏覽器確認。 */
  const [confirmFailed, setConfirmFailed] = useState(false);
  /** 這台瀏覽器先前存下的收據（「查看我的收據」）：帶 tx hash 的歷史＋可能的 pending。 */
  const [stored,        setStored]        = useState<StoredKycReceipts | null>(null);
  const [showStored,    setShowStored]    = useState(false);

  /**
   * 上一筆送出的交易（history 最新一筆）目前的狀態。關掉再開時父層不一定已 refetch，
   * 所以開啟時自己查：只有確定可以重送才解鎖送出鍵。
   *   checking     查詢中（停用）
   *   unconfirmed  交易還沒有 receipt（停用）
   *   underReview  交易成功且鏈上 isPending(user) 為真（停用）
   *   checkFailed  查不到（停用，附重試）
   *   clear        沒有上一筆、上一筆 receipt 為失敗（status 0），或已不在待審（例如已撤銷）
   */
  const [prevTx, setPrevTx] = useState<'checking' | 'unconfirmed' | 'underReview' | 'checkFailed' | 'clear'>('clear');
  const [prevTxRun, setPrevTxRun] = useState(0);

  // 每次開啟：清掉上一輪的錯誤與「確認失敗」，改由鏈上查詢決定能不能重送。
  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setConfirmFailed(false);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !kycRegistry) return;
    let cancelled = false;
    setPrevTx('checking');
    void (async () => {
      const loc = await receiptLocation(kycRegistry);
      if (cancelled) return;
      const latest = loc ? loadKycReceipts(loc).history[0] : undefined;
      if (!loc || !latest?.txHash) { setPrevTx('clear'); return; }
      try {
        const provider = (kycRegistry.runner as { provider?: { getTransactionReceipt: (h: string) => Promise<{ status: number | null } | null> } } | null)?.provider;
        if (!provider) throw new Error('no provider');
        const rc = await provider.getTransactionReceipt(latest.txHash);
        if (cancelled) return;
        if (!rc) { setPrevTx('unconfirmed'); return; }
        if (rc.status === 0) { setPrevTx('clear'); return; }
        // 交易成功：鏈上仍在待審就不能重送；已核准或已撤銷才放行（撤銷後需要能重新申請）。
        let pendingNow: boolean;
        try {
          pendingNow = (await kycRegistry.isPending(loc.user)) as boolean;
        } catch {
          // 線上 Base Sepolia 的舊版 KYCRegistry 沒有 isPending（missing revert data）：
          // 那一版沒有審核佇列，submitKYC 上鏈即完成。確認合約讀得到（isVerified）就放行，
          // 讀不到才當成查詢失敗。
          await kycRegistry.isVerified(loc.user);
          pendingNow = false;
        }
        if (!cancelled) setPrevTx(pendingNow ? 'underReview' : 'clear');
      } catch {
        if (!cancelled) setPrevTx('checkFailed');
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, kycRegistry, prevTxRun]);

  const prevTxBlocks = prevTx !== 'clear';

  useEffect(() => {
    if (!isOpen || !kycRegistry) return;
    let cancelled = false;
    void receiptLocation(kycRegistry).then((loc) => {
      if (cancelled) return;
      setStored(loc ? loadKycReceipts(loc) : null);
    });
    return () => { cancelled = true; };
  }, [isOpen, kycRegistry, submitted, confirmFailed]);

  const awaitingReview = isPending || submitted;

  const handleSubmit = async () => {
    if (!kycRegistry) return;
    if (!fullName.trim()) { setError(t.kyc.nameRequired); return; }
    setBusy(true);
    setError(null);
    // 個資不上鏈：送的是 keccak256(salt ‖ 正規化姓名) 與 keccak256(salt ‖ 國籍代碼)，
    // 合約參數型別仍是 string（hex 字串）。salt 只留在使用者端，明文連本機都不存。
    const submission = buildKycSubmission(fullName, nationality);
    const loc = await receiptLocation(kycRegistry);
    const base = (txHash: string | null) =>
      toKycReceipt(submission, { chainId: loc?.chainId ?? null, registry: loc?.registry ?? '', user: loc?.user ?? '', txHash });
    const show = (txHash: string, saved: boolean) => {
      setReceipt({
        ...base(txHash),
        normalizedName: submission.normalizedName,
        normalizedNationality: submission.normalizedNationality,
      });
      setReceiptSaved(saved);
    };

    // 送交易「之前」先存到 pending（與歷史收據分開的 key）：交易成功但頁面在拿到
    // hash 前就關掉的話，salt 還找得回來；取消時只刪 pending，不會動到舊收據。
    if (loc) savePendingKycReceipt(base(null));
    let txHash: string | null = null;
    try {
      const tx = asTx(await kycRegistry.submitKYC(...kycSubmitArgs(submission)));
      txHash = tx.hash;
      // 一拿到 hash 就升格進歷史（以 txHash 為索引）——之後 wait() 失敗，交易也可能已經上鏈。
      const saved = loc ? promoteKycReceipt({ ...base(txHash), txHash }) : false;
      try {
        await tx.wait();
      } catch (waitErr) {
        // 已送出（有 hash）但確認失敗：收據保留並顯示，停用送出鍵，請使用者先到瀏覽器確認。
        show(txHash, saved);
        setConfirmFailed(true);
        setError(prettyError(waitErr));
        // 父層也要 refetch：交易可能已上鏈，關掉再開時要看到「審核中」而不是能重送。
        onSuccess();
        return;
      }
      show(txHash, saved);
      // submitKYC 現在只 emit KYCSubmitted——使用者「還沒」通過。舊版在這裡直接
      // onClose()，畫面看起來就像驗證完成了，然後他回去下單被合約 revert
      // NotKycVerified，完全不知道發生什麼事。改成留在原地明確告知「待審核」。
      setSubmitted(true);
      onSuccess();
    } catch (e) {
      // 錢包取消或送出前就失敗（沒有 tx hash）：只刪這一次的 pending，歷史收據不動。
      if (loc && !txHash) clearPendingKycReceipt(loc, submission.salt);
      setReceipt(null);
      setError(prettyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
      PaperProps={{
        sx: {
          borderRadius: 2,
          p: 1.5,
          bgcolor: 'background.paper',
          backgroundImage: 'none',
        },
      }}
    >
      <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', pb: 1 }}>
        <Box>
          <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
            {awaitingReview ? t.kyc.titleAwaitingReview : t.kyc.title}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t.kyc.subtitle}
          </Typography>
        </Box>
        <IconButton
          size="small"
          onClick={onClose}
          aria-label={t.kyc.closeAria}
          sx={{ color: 'text.secondary', p: 0.5 }}
        >
          {/* Iconify rather than a bare "✕" glyph: the character renders at a
              different weight and baseline in every font, and cannot inherit
              the icon sizing used by every other close button here. */}
          <Iconify icon="mingcute:close-line" width={18} />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, pt: 1 }}>
        {/* 審核制說明。這是這個 Dialog 最重要的一句話：送出 ≠ 通過。 */}
        <Alert severity={awaitingReview ? 'success' : 'info'} variant="outlined">
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 0.5 }}>
            {awaitingReview ? t.kyc.noticeTitleAwaitingReview : t.kyc.noticeTitle}
          </Typography>
          <Typography variant="caption" display="block" sx={{ opacity: 0.9 }}>
            {awaitingReview ? t.kyc.noticeBodyAwaitingReview : t.kyc.noticeBody}
          </Typography>
        </Alert>

        {/* Demo disclaimer — 已送出待審時不用再看填表注意事項 */}
        {!awaitingReview && (
        <Alert
          severity="warning"
          variant="outlined"
          sx={{
            bgcolor: 'rgba(255, 171, 0, 0.08)',
            borderColor: 'rgba(255, 171, 0, 0.24)',
            color: 'warning.main',
            '& .MuiAlert-icon': { color: 'warning.main' },
          }}
        >
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 0.5 }}>
            {t.kyc.demoTitle}
          </Typography>
          <Typography variant="caption" display="block" sx={{ opacity: 0.9 }}>
            {t.kyc.demoBody}
          </Typography>
        </Alert>
        )}

        {/* 揭露：舊版前端曾把姓名與國籍明文寫上鏈，那些資料無法刪除。 */}
        {!awaitingReview && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            {t.kyc.legacyPlaintextNotice}
          </Typography>
        )}

        {/* 查看這台瀏覽器先前存下的收據（只有 salt 與雜湊，沒有明文），新到舊。
            剛送出、上方已經顯示的那一筆不重複列出。 */}
        {(() => {
          if (!stored) return null;
          const shownSalt = receipt && (submitted || confirmFailed) ? receipt.salt.toLowerCase() : null;
          const history = stored.history.filter((r) => r.salt.toLowerCase() !== shownSalt);
          const pending = stored.pending.filter((r) => r.salt.toLowerCase() !== shownSalt);
          if (history.length + pending.length === 0) return null;
          return (
            <Box>
              <Button size="small" variant="text" onClick={() => setShowStored((v) => !v)} sx={{ px: 0 }}>
                {showStored
                  ? t.kyc.receipt.hideMine
                  : interpolate(t.kyc.receipt.viewMineCount, { count: history.length + pending.length })}
              </Button>
              {showStored && (
                <Box sx={{ mt: 1 }}>
                  {history.map((r) => (
                    <Box key={r.txHash} sx={{ mb: 1.5 }}>
                      <Typography variant="caption" display="block" color="text.secondary" sx={{ mb: 1 }}>
                        {interpolate(t.kyc.receipt.storedAt, { time: new Date(r.createdAt).toLocaleString() })}
                      </Typography>
                      <ReceiptFields r={r} />
                    </Box>
                  ))}
                  {pending.map((r) => (
                    <Box key={r.salt} sx={{ mb: 1.5 }}>
                      <Typography variant="caption" display="block" color="warning.main" sx={{ mb: 1 }}>
                        {interpolate(t.kyc.receipt.pendingStoredAt, { time: new Date(r.createdAt).toLocaleString() })}
                      </Typography>
                      <ReceiptFields r={r} />
                    </Box>
                  ))}
                </Box>
              )}
            </Box>
          );
        })()}

        {/* 上一筆交易的狀態：不能重送時說明原因（查詢失敗附重試）。 */}
        {!awaitingReview && prevTxBlocks && !confirmFailed && (
          <Alert
            severity={prevTx === 'checking' ? 'info' : 'warning'}
            action={prevTx === 'checkFailed' ? (
              <Button color="inherit" size="small" onClick={() => setPrevTxRun((n) => n + 1)}>
                {t.kyc.prevTx.retry}
              </Button>
            ) : undefined}
          >
            {t.kyc.prevTx[prevTx]}
          </Alert>
        )}

        {/* 送出後：salt 與雜湊只在這裡出現一次，請使用者自行保存。 */}
        {receipt && (submitted || confirmFailed) && (
          <Alert severity="warning" variant="outlined">
            <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 0.5 }}>
              {t.kyc.receipt.title}
            </Typography>
            <Typography variant="caption" display="block" sx={{ mb: 1 }}>
              {receiptSaved ? t.kyc.receipt.savedLocally : t.kyc.receipt.notSaved}
            </Typography>
            {confirmFailed && (
              <Typography variant="caption" display="block" color="error.main" sx={{ mb: 1 }}>
                {t.kyc.receipt.confirmFailed}
              </Typography>
            )}
            <ReceiptFields r={receipt} />
            <Typography variant="caption" display="block" color="text.secondary">
              {interpolate(t.kyc.receipt.scheme, { name: receipt.normalizedName, code: receipt.normalizedNationality })}
            </Typography>
          </Alert>
        )}

        {/* Form — 待審核時隱藏，重複送出只是再燒一次 gas */}
        {!awaitingReview && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField
            label={t.kyc.nameLabel}
            placeholder={t.kyc.namePlaceholder}
            fullWidth
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            disabled={busy}
            slotProps={{
              inputLabel: { shrink: true },
            }}
          />

          <FormControl fullWidth>
            <InputLabel id="nationality-select-label" shrink>{t.kyc.nationalityLabel}</InputLabel>
            <Select
              labelId="nationality-select-label"
              value={nationality}
              onChange={(e) => setNationality(e.target.value)}
              disabled={busy}
              label={t.kyc.nationalityLabel}
              notched
            >
              {COUNTRIES.map((c) => (
                <MenuItem key={c} value={c}>
                  {interpolate(t.kyc.nationalityOption, { code: c, name: COUNTRY_NAMES[c] ?? c })}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>
        )}

        {error && (
          <Alert severity="error" sx={{ py: 0 }}>
            {error}
          </Alert>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2, gap: 1.5 }}>
        <Button
          variant="outlined"
          color="inherit"
          onClick={onClose}
          disabled={busy}
          fullWidth
          sx={{ py: 1.2 }}
        >
          {awaitingReview ? t.kyc.close : t.kyc.cancel}
        </Button>
        {!awaitingReview && (
          <Button
            variant="contained"
            color="primary"
            onClick={() => void handleSubmit()}
            // confirmFailed：上一筆交易可能已上鏈，先到區塊瀏覽器確認，不要重送。
            disabled={busy || !fullName.trim() || !kycRegistry || confirmFailed || prevTxBlocks}
            fullWidth
            sx={{ py: 1.2, fontWeight: 'bold' }}
          >
            {busy ? t.kyc.submitting : t.kyc.submit}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

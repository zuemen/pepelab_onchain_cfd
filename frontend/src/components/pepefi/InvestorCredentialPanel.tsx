import type { WalletAPI } from 'src/hooks/useWallet'
import type { VerifiedInvestorCredential } from 'src/contracts/investorCredential'

import { Contract } from 'ethers'
import { useState, useEffect, useCallback } from 'react'

import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Alert from '@mui/material/Alert'
import Stack from '@mui/material/Stack'
import Button from '@mui/material/Button'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'

import { t, interpolate } from 'src/locales'
import { getVcKycRegistryAddress } from 'src/contracts/vcKycRegistry'
import { CREDENTIAL_TYPE_IDS, VC_KYC_REGISTRY_ABI } from 'src/contracts/investorCredential'
import {
  submitBlocker,
  verifyPastedCredential,
  fetchCredentialStatus,
  type StatusCheck,
  type OnchainEligibility,
} from 'src/lib/pepefi/investorCredentialCheck'

// ----------------------------------------------------------------------

/**
 * 合格投資人憑證（VC）→ 鏈上資格。docs/SSI_RWA_ACCESS.md §6。
 *
 * 1. 上傳或貼上發證者給的 VC（JSON）
 * 2. 本地驗證：EIP-712 簽章、效期、domain（chainId＋registry）、狀態清單（撤銷）
 * 3. 送出 attestation 上鏈（VCKycRegistry.submitAttestation，合約再驗一次簽章與信任）
 * 4. 顯示目前的資格與到期日
 *
 * registry 位址未設定時，整個面板降級為「此部署尚未啟用 VC 准入」。
 */

const fmtDate = (sec: number) => (sec > 0 ? new Date(sec * 1000).toISOString().replace('.000Z', 'Z') : '—')

type Props = { wallet: WalletAPI; registryAddress?: string | null }

export function InvestorCredentialPanel({ wallet, registryAddress }: Props) {
  const registry = registryAddress === undefined ? getVcKycRegistryAddress(wallet.chainId) : registryAddress
  const [text, setText] = useState('')
  const [vc, setVc] = useState<VerifiedInvestorCredential | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<StatusCheck | null>(null)
  const [chain, setChain] = useState<OnchainEligibility | null>(null)
  const [mine, setMine] = useState<{ valid: boolean; expiresAt: number; isVerified: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [txHash, setTxHash] = useState<string | null>(null)

  const readMine = useCallback(async () => {
    if (!registry || !wallet.provider || !wallet.address) return
    try {
      const reg = new Contract(registry, VC_KYC_REGISTRY_ABI as unknown as string[], wallet.provider)
      const [[rec, valid], isVerified] = await Promise.all([
        reg.credentialOf(wallet.address, CREDENTIAL_TYPE_IDS.QUALIFIED_INVESTOR),
        reg.isVerified(wallet.address),
      ])
      setMine({ valid: Boolean(valid), expiresAt: Number(rec.expiresAt), isVerified: Boolean(isVerified) })
    } catch {
      setMine(null)
    }
  }, [registry, wallet.provider, wallet.address])

  useEffect(() => {
    readMine()
  }, [readMine])

  if (!registry) {
    return (
      <Card sx={{ p: 3 }}>
        <Typography variant="h6" sx={{ mb: 1 }}>
          {t.investorVc.title}
        </Typography>
        <Alert severity="info" data-testid="vc-kyc-disabled">
          {t.investorVc.disabled}
        </Alert>
      </Card>
    )
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setText(await file.text())
  }

  const verify = async () => {
    setError(null)
    setVc(null)
    setStatus(null)
    setChain(null)
    setTxHash(null)
    const r = verifyPastedCredential(text, { expectedRegistry: registry })
    if (!r.valid) {
      setError(interpolate(t.investorVc.invalid, { code: r.reasonCode, reason: r.reason }))
      return
    }
    setVc(r)
    setStatus(await fetchCredentialStatus(r, JSON.parse(text)))
    if (!wallet.provider) return
    try {
      const reg = new Contract(registry, VC_KYC_REGISTRY_ABI as unknown as string[], wallet.provider)
      const [issuerTrusted, revokedOnChain, submitted, subjectNonce, [rec, valid], isVerified] = await Promise.all([
        reg.trustedIssuer(r.issuer, r.value.credentialType),
        reg.revoked(r.issuer, r.credentialHash),
        reg.credentialUsed(r.credentialHash),
        reg.nonces(r.subject),
        reg.credentialOf(r.subject, r.value.credentialType),
        reg.isVerified(r.subject),
      ])
      setChain({
        issuerTrusted: Boolean(issuerTrusted),
        revokedOnChain: Boolean(revokedOnChain),
        submitted: Boolean(submitted),
        subjectNonce: BigInt(subjectNonce),
        registeredValid: Boolean(valid),
        registeredExpiresAt: Number(rec.expiresAt),
        isVerified: Boolean(isVerified),
      })
    } catch (e) {
      setError(interpolate(t.investorVc.chainReadFailed, { reason: (e as Error).message }))
    }
  }

  const blocker = vc && chain ? submitBlocker(vc, chain, wallet.chainId) : null
  const statusBlocks = status?.status === 'revoked'

  const submit = async () => {
    if (!vc || !wallet.signer) return
    setBusy(true)
    setError(null)
    try {
      const reg = new Contract(registry, VC_KYC_REGISTRY_ABI as unknown as string[], wallet.signer)
      const a = vc.value
      const tx = await reg.submitAttestation(
        {
          subject: a.subject,
          credentialType: a.credentialType,
          credentialHash: a.credentialHash,
          statusListIndex: BigInt(a.statusListIndex),
          issuedAt: BigInt(a.issuedAt),
          expiresAt: BigInt(a.expiresAt),
          nonce: BigInt(a.nonce),
          deadline: BigInt(a.deadline),
        },
        vc.signature
      )
      setTxHash(tx.hash)
      await tx.wait()
      await readMine()
      await verify()
    } catch (e) {
      const reason = (e as { reason?: string; shortMessage?: string }).reason ?? (e as { shortMessage?: string }).shortMessage
      setError(interpolate(t.investorVc.submitFailed, { reason: reason ?? (e as Error).message }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card sx={{ p: 3 }} data-testid="vc-kyc-panel">
      <Stack spacing={2}>
        <Box>
          <Typography variant="h6">{t.investorVc.title}</Typography>
          <Typography variant="body2" color="text.secondary">
            {t.investorVc.intro}
          </Typography>
        </Box>

        {mine && (
          <Alert severity={mine.isVerified ? 'success' : 'warning'} data-testid="vc-kyc-mine">
            {mine.isVerified
              ? interpolate(t.investorVc.mineVerified, { date: fmtDate(mine.expiresAt) })
              : t.investorVc.mineNotVerified}
          </Alert>
        )}

        <Stack direction="row" spacing={1}>
          <Button variant="outlined" component="label">
            {t.investorVc.upload}
            <input hidden type="file" accept="application/json,.json" onChange={(e) => onFile(e.target.files?.[0])} />
          </Button>
          <Button variant="contained" onClick={verify} disabled={!text.trim()}>
            {t.investorVc.verify}
          </Button>
        </Stack>
        <TextField
          label={t.investorVc.pasteLabel}
          multiline
          minRows={4}
          maxRows={12}
          value={text}
          onChange={(e) => setText(e.target.value)}
          inputProps={{ spellCheck: false, style: { fontFamily: 'monospace', fontSize: 12 } }}
        />

        {error && <Alert severity="error">{error}</Alert>}

        {vc && (
          <Stack spacing={1} data-testid="vc-kyc-result">
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Chip color="success" label={t.investorVc.chip.signatureOk} />
              <Chip label={t.investorVc.typeLabel[vc.credentialType]} />
              <Chip
                color={status?.status === 'active' ? 'success' : status?.status === 'revoked' ? 'error' : 'warning'}
                label={
                  status?.status === 'active'
                    ? t.investorVc.chip.active
                    : status?.status === 'revoked'
                      ? t.investorVc.chip.revoked
                      : t.investorVc.chip.unknown
                }
              />
              {chain && (
                <Chip
                  color={chain.issuerTrusted ? 'success' : 'error'}
                  label={chain.issuerTrusted ? t.investorVc.chip.issuerTrusted : t.investorVc.chip.issuerUntrusted}
                />
              )}
            </Stack>
            <Typography variant="body2">{interpolate(t.investorVc.holder, { address: vc.subject })}</Typography>
            <Typography variant="body2">{interpolate(t.investorVc.issuer, { address: vc.issuer })}</Typography>
            <Typography variant="body2">
              {interpolate(t.investorVc.validity, {
                from: fmtDate(vc.issuedAt),
                to: fmtDate(vc.expiresAt),
                deadline: fmtDate(vc.deadline),
              })}
            </Typography>
            {status && (
              <Typography variant="body2" color="text.secondary">
                {status.message}
              </Typography>
            )}
            {blocker && <Alert severity="warning">{blocker}</Alert>}
            <Box>
              <Button
                variant="contained"
                onClick={submit}
                disabled={busy || !wallet.signer || !chain || !!blocker || statusBlocks}
              >
                {busy ? t.investorVc.submitting : t.investorVc.submit}
              </Button>
            </Box>
            {txHash && (
              <Typography variant="caption" sx={{ wordBreak: 'break-all' }}>
                {interpolate(t.investorVc.tx, { hash: txHash })}
              </Typography>
            )}
          </Stack>
        )}
      </Stack>
    </Card>
  )
}

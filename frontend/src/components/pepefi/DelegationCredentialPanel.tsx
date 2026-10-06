// v3 delegation credential panel (docs/SSI_AGENT_DELEGATION.md):
//   1. the session user signs an AgentDelegationCredential in their wallet (EIP-712),
//      mirroring the on-chain session field by field plus an x402 spending allowance;
//   2. anchors its hash in SessionCredentialAnchor (one tx, only the session user can);
//   3. sees the agent DID, the credential, its status and the x402 spend signal-api has
//      accumulated for it; can revoke it through the ADR-016 status list.
// Display strings come from t.sessions.delegation (locale catalogs).
import type { Signer } from 'ethers'

import { useState, useEffect, useCallback } from 'react'
import { Contract, formatUnits, getAddress } from 'ethers'

import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import LinearProgress from '@mui/material/LinearProgress'

import { t, interpolate } from 'src/locales'
import { MONO } from 'src/components/pepefi/brandKit'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import { SIGNAL_API_URL } from 'src/lib/pepefi/signalApi'
import { useToast } from 'src/components/pepefi/ToastProvider'
import { AgentSessionManagerABI } from 'src/contracts/sessionManager'
import { getSessionAnchor, isSessionAnchorDeployed } from 'src/contracts/sessionCredentialAnchor'
import {
  didPkh,
  assembleDelegationCredential,
  type DelegationCredential,
} from 'src/contracts/agentAuth'
import { assembleStatusList, type CredentialStatusList } from 'src/contracts/agentAuthStatus'
import {
  credentialHash as hashOf,
  fetchKyaSpend,
  spendPercent,
  DEFAULT_X402_FORM,
  buildFieldsForSession,
  delegationTypedData,
  revocationListFields,
  statusListTypedData,
  statusListStorageKey,
  type KyaSpend,
  type SessionTerms,
  type StoredDelegation,
  type X402AllowanceForm,
} from 'src/lib/pepefi/delegationCredential'

export interface DelegationSession extends Omit<SessionTerms, 'allowedAssets'> {
  user: string
  revoked: boolean
}

const fUsdc6 = (v: bigint) => Number(formatUnits(v, 6)).toLocaleString('en-US', { maximumFractionDigits: 6 })
const f18 = (v: bigint) => Number(formatUnits(v, 18)).toLocaleString('en-US', { maximumFractionDigits: 4 })

function downloadJson(name: string, obj: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/** Last status list this user signed (lists are cumulative); localStorage, best effort. */
function loadLastList(sessionManager: string, user: string): CredentialStatusList | null {
  try {
    const raw = localStorage.getItem(statusListStorageKey(sessionManager, user))
    return raw ? (JSON.parse(raw) as CredentialStatusList) : null
  } catch {
    return null
  }
}

/**
 * Sign the ADR-016 status list that revokes `credential` (carrying over earlier revocations),
 * remember it locally, publish it if VITE_VC_STATUS_PUBLISH_URL is set, else download it.
 * Returns the signed list and whether it was published.
 */
export async function revokeDelegationCredential(p: {
  signer: Signer
  user: string
  sessionManager: string
  credential: DelegationCredential
}): Promise<{ list: CredentialStatusList; published: boolean }> {
  const previous = loadLastList(p.sessionManager, p.user)
  const fields = revocationListFields({ issuer: getAddress(p.user), jti: p.credential.credentialSubject.nonce, previous })
  const td = statusListTypedData(fields, p.sessionManager)
  const signature = await p.signer.signTypedData(td.domain, td.types, td.value)
  const list = assembleStatusList({ ...fields, issuerAddress: getAddress(p.user), signature, verifyingContract: p.sessionManager })
  try {
    localStorage.setItem(statusListStorageKey(p.sessionManager, p.user), JSON.stringify(list))
  } catch {
    /* quota: the download below is the durable copy */
  }
  const publishUrl = (import.meta.env.VITE_VC_STATUS_PUBLISH_URL as string | undefined)?.trim()
  if (publishUrl) {
    try {
      const r = await fetch(publishUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(list) })
      if (r.ok) return { list, published: true }
    } catch {
      /* fall through to download */
    }
  }
  downloadJson(`vc-status-${p.user.toLowerCase()}-seq${list.sequence}.json`, list)
  return { list, published: false }
}

export function DelegationCredentialPanel({
  session,
  chainId,
  signer,
  userAddress,
  sessionManager,
  stored,
  onStored,
}: {
  session: DelegationSession
  chainId: number
  signer: Signer | null
  userAddress: string
  sessionManager: string
  stored: StoredDelegation | undefined
  onStored: (next: StoredDelegation) => void
}) {
  const { notify } = useToast()
  const [form, setForm] = useState<X402AllowanceForm>(DEFAULT_X402_FORM)
  const [validityDays, setValidityDays] = useState('30')
  const [assets, setAssets] = useState<string[] | null>(null)
  const [busy, setBusy] = useState<'' | 'issue' | 'anchor' | 'revoke'>('')
  const [anchored, setAnchored] = useState<boolean | null>(null)
  const [spend, setSpend] = useState<KyaSpend | null>(null)
  const [showJson, setShowJson] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const anchorDeployed = isSessionAnchorDeployed(chainId)

  // allowedAssets(id) is not in the page's session row; read it once.
  useEffect(() => {
    if (!signer) return
    const mgr = new Contract(sessionManager, AgentSessionManagerABI, signer)
    mgr.allowedAssets(session.id).then(
      (a: string[]) => setAssets([...a]),
      () => setAssets(null),
    )
  }, [signer, sessionManager, session.id])

  const refresh = useCallback(async () => {
    if (!stored) return
    const anchor = getSessionAnchor(signer as never, chainId)
    if (anchor) {
      try {
        setAnchored(Boolean(await anchor.isAnchored(session.id, stored.credentialHash)))
      } catch {
        setAnchored(null)
      }
    }
    setSpend(await fetchKyaSpend(SIGNAL_API_URL, stored.credentialHash, stored.credential.credentialSubject.x402.periodSeconds))
  }, [stored, signer, chainId, session.id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const issue = async () => {
    if (!signer || assets === null) return
    setFormError(null)
    let fields
    try {
      fields = buildFieldsForSession({
        issuer: getAddress(userAddress),
        sessionManager,
        session: { ...session, allowedAssets: assets },
        x402: form,
        validityDays: Number(validityDays),
      })
    } catch (e) {
      const code = (e as Error).message as keyof typeof t.sessions.delegation.formError
      setFormError(t.sessions.delegation.formError[code] ?? (e as Error).message)
      return
    }
    try {
      setBusy('issue')
      const td = delegationTypedData(fields, chainId)
      const signature = await signer.signTypedData(td.domain, td.types, td.value)
      const credential = assembleDelegationCredential({ fields, chainId, signature })
      onStored({ credential, credentialHash: hashOf(fields, chainId) })
      notify(t.sessions.delegation.issuedToast, true)
    } catch (e) {
      notify(prettyError(e), false)
    } finally {
      setBusy('')
    }
  }

  const anchorIt = async () => {
    const anchor = getSessionAnchor(signer as never, chainId)
    if (!anchor || !stored) return
    try {
      setBusy('anchor')
      const tx = (await anchor.anchor(session.id, stored.credentialHash)) as { wait(): Promise<unknown>; hash: string }
      await tx.wait()
      onStored({ ...stored, anchoredTx: tx.hash })
      notify(t.sessions.delegation.anchoredToast, true, tx.hash)
      await refresh()
    } catch (e) {
      notify(prettyError(e), false)
    } finally {
      setBusy('')
    }
  }

  const revoke = async () => {
    if (!signer || !stored) return
    try {
      setBusy('revoke')
      const r = await revokeDelegationCredential({ signer, user: userAddress, sessionManager, credential: stored.credential })
      onStored({ ...stored, revoked: true })
      notify(
        interpolate(r.published ? t.sessions.delegation.revokedPublished : t.sessions.delegation.revokedDownloaded, {
          seq: String(r.list.sequence),
        }),
        true,
      )
    } catch (e) {
      notify(prettyError(e), false)
    } finally {
      setBusy('')
    }
  }

  const d = t.sessions.delegation
  const vc = stored?.credential
  const expired = vc ? Date.parse(vc.validUntil) < Date.now() : false
  const status = session.revoked
    ? { label: d.statusSessionRevoked, color: 'default' as const }
    : stored?.revoked
      ? { label: d.statusRevoked, color: 'error' as const }
      : expired
        ? { label: d.statusExpired, color: 'warning' as const }
        : { label: d.statusActive, color: 'success' as const }

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">{d.intro}</Typography>

      <Box>
        <Typography variant="caption" color="text.secondary">{d.agentDid}</Typography>
        <Typography sx={{ fontFamily: MONO, fontSize: 12, wordBreak: 'break-all' }}>{didPkh(session.agent, chainId)}</Typography>
        <Typography variant="caption" color="text.secondary">{d.issuerDid}</Typography>
        <Typography sx={{ fontFamily: MONO, fontSize: 12, wordBreak: 'break-all' }}>{didPkh(userAddress, chainId)}</Typography>
      </Box>

      <Box>
        <Typography variant="caption" color="text.secondary">{d.sessionTerms}</Typography>
        <Typography sx={{ fontFamily: MONO, fontSize: 12 }}>
          #{session.id} · {f18(session.maxMarginPerTrade)} / {f18(session.totalMarginBudget)} · {Number(session.maxLeverage)}x ·{' '}
          {assets === null ? '…' : assets.length === 0 ? d.assetsAll : interpolate(d.assetsCount, { n: String(assets.length) })}
        </Typography>
      </Box>

      {!vc && (
        <Stack spacing={1.5}>
          <Typography variant="subtitle2">{d.x402Title}</Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <TextField size="small" label={d.perPeriod} value={form.perPeriodUsdc} onChange={(e) => setForm({ ...form, perPeriodUsdc: e.target.value })} />
            <TextField size="small" label={d.periodHours} value={form.periodHours} onChange={(e) => setForm({ ...form, periodHours: e.target.value })} />
            <TextField size="small" label={d.total} value={form.totalUsdc} onChange={(e) => setForm({ ...form, totalUsdc: e.target.value })} />
            <TextField size="small" label={d.validityDays} value={validityDays} onChange={(e) => setValidityDays(e.target.value)} />
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {d.endpoints}: <Box component="span" sx={{ fontFamily: MONO }}>{form.endpoints.join(', ')}</Box>
          </Typography>
          {formError && <Alert severity="error">{formError}</Alert>}
          <Box>
            <Button
              variant="contained"
              onClick={() => void issue()}
              disabled={!signer || assets === null || busy !== '' || session.revoked || Number(session.expiry) * 1000 < Date.now()}
              sx={{ textTransform: 'none' }}
            >
              {busy === 'issue' ? d.signing : d.issue}
            </Button>
          </Box>
        </Stack>
      )}

      {vc && stored && (
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="subtitle2">{d.statusTitle}</Typography>
            <Chip size="small" variant="outlined" label={status.label} color={status.color} />
            {anchorDeployed && (
              <Chip
                size="small"
                variant="outlined"
                color={anchored ? 'success' : 'default'}
                label={anchored ? d.anchored : stored.anchoredTx ? d.superseded : d.notAnchored}
              />
            )}
          </Stack>
          <Box>
            <Typography variant="caption" color="text.secondary">{d.credentialHash}</Typography>
            <Typography sx={{ fontFamily: MONO, fontSize: 12, wordBreak: 'break-all' }}>{stored.credentialHash}</Typography>
          </Box>
          {!anchorDeployed && <Alert severity="info">{d.anchorNotDeployed}</Alert>}

          <Box>
            <Typography variant="subtitle2">{d.spendTitle}</Typography>
            {spend ? (
              <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                {(
                  [
                    [d.spendTotal, spend.totalAtomic, BigInt(vc.credentialSubject.x402.maxTotal)],
                    [d.spendPeriod, spend.periodAtomic, BigInt(vc.credentialSubject.x402.maxPerPeriod)],
                  ] as const
                ).map(([label, spent, cap]) => (
                  <Box key={label}>
                    <Typography variant="caption">{interpolate(label, { spent: fUsdc6(spent), cap: fUsdc6(cap) })}</Typography>
                    <LinearProgress variant="determinate" value={spendPercent(spent, cap)} />
                  </Box>
                ))}
              </Stack>
            ) : (
              <Typography variant="caption" color="text.secondary">{d.spendUnavailable}</Typography>
            )}
          </Box>

          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {anchorDeployed && !anchored && !stored.revoked && !session.revoked && (
              <Button variant="contained" onClick={() => void anchorIt()} disabled={busy !== ''} sx={{ textTransform: 'none' }}>
                {busy === 'anchor' ? d.anchoring : d.anchor}
              </Button>
            )}
            <Button variant="outlined" onClick={() => setShowJson(!showJson)} sx={{ textTransform: 'none' }}>
              {showJson ? d.hideJson : d.showJson}
            </Button>
            <Button
              variant="outlined"
              onClick={() => downloadJson(`delegation-vc-v3-session${session.id}.json`, vc)}
              sx={{ textTransform: 'none' }}
            >
              {d.download}
            </Button>
            {!stored.revoked && (
              <Button variant="outlined" color="error" onClick={() => void revoke()} disabled={busy !== '' || !signer} sx={{ textTransform: 'none' }}>
                {busy === 'revoke' ? d.revoking : d.revoke}
              </Button>
            )}
          </Stack>
          {showJson && (
            <Box
              component="pre"
              sx={{ fontFamily: MONO, fontSize: 11, p: 1.5, bgcolor: 'background.neutral', borderRadius: 1, overflow: 'auto', maxHeight: 320 }}
            >
              {JSON.stringify(vc, null, 2)}
            </Box>
          )}
        </Stack>
      )}
    </Stack>
  )
}

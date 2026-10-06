// v3 delegation credential panel (docs/SSI_AGENT_DELEGATION.md):
//   1. the session user signs an AgentDelegationCredential in their wallet (EIP-712),
//      mirroring the on-chain session field by field plus an x402 spending allowance;
//   2. anchors its hash in SessionCredentialAnchor (one tx, only the session user can);
//   3. sees the agent DID, the credential, its status and the x402 spend signal-api has
//      accumulated for it; can revoke it through the ADR-016 status list (built on the list
//      that is actually published, and shown as revoked only once the new list is published),
//      and can unanchor it (takes effect at once for paid APIs that require the anchor).
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
import { getSessionAnchor, sessionAnchorProblem, isSessionAnchorDeployed } from 'src/contracts/sessionCredentialAnchor'
import {
  didPkh,
  assembleDelegationCredential,
  type DelegationCredential,
} from 'src/contracts/agentAuth'
import { assembleStatusList, type CredentialStatusList } from 'src/contracts/agentAuthStatus'
import {
  credentialHash as hashOf,
  fetchKyaSpend,
  revocationBase,
  statusListProblem,
  fetchPublishedStatusList,
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

/** Where verifiers read published lists (`<base>/<issuer>.json`, the agent's VC_STATUS_URL). */
const statusUrl = () => (import.meta.env.VITE_VC_STATUS_URL as string | undefined)?.trim()

/** True when the published list for `user` already revokes `credential`. */
async function isRevocationPublished(user: string, sessionManager: string, credential: DelegationCredential): Promise<boolean> {
  const pub = await fetchPublishedStatusList(statusUrl(), user, sessionManager)
  return pub.kind === 'list' && pub.list.revoked.includes(credential.credentialSubject.nonce.toLowerCase())
}

/**
 * Sign the ADR-016 status list that revokes `credential`, carrying over every earlier revocation.
 * The base is the list verifiers actually hold (fetched from VITE_VC_STATUS_URL and verified, or
 * a list the user imports) — never just this browser's memory: a list built on a stale base is
 * rejected by verifiers, and the revocation would silently not take effect. No trustworthy base
 * → throws, nothing is signed. Publishes via VITE_VC_STATUS_PUBLISH_URL when set, else downloads;
 * `published` is true only when the new list is confirmed visible at VITE_VC_STATUS_URL.
 */
export async function revokeDelegationCredential(p: {
  signer: Signer
  user: string
  sessionManager: string
  credential: DelegationCredential
  /** The currently published list, imported by the user when VITE_VC_STATUS_URL cannot be read. */
  imported?: CredentialStatusList | null
  /** The user explicitly confirmed nothing has been published for them yet (first revocation, sequence 1). */
  confirmedNoPublishedList?: boolean
}): Promise<{ list: CredentialStatusList; published: boolean }> {
  let published = p.imported ? { kind: 'list' as const, list: p.imported } : await fetchPublishedStatusList(statusUrl(), p.user, p.sessionManager)
  if (published.kind === 'unavailable' && p.confirmedNoPublishedList) published = { kind: 'none' }
  const base = revocationBase(published, loadLastList(p.sessionManager, p.user))
  if (!base.ok) throw new Error(interpolate(t.sessions.delegation.revokeBaseUnavailable, { reason: base.reason }))
  const fields = revocationListFields({ issuer: getAddress(p.user), jti: p.credential.credentialSubject.nonce, previous: base.previous })
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
      // Accepted by the publisher is not yet "verifiers see it": confirm by reading it back.
      if (r.ok && (await isRevocationPublished(p.user, p.sessionManager, p.credential))) return { list, published: true }
      // Accepted but not readable back yet: still hand the user the durable copy below.
    } catch {
      /* fall through to download */
    }
  }
  downloadJson(`vc-status-${p.user.toLowerCase()}-seq${list.sequence}.json`, list)
  return { list, published: false }
}

/** The stored record after a revocation attempt: revoked only when confirmed published. */
export function afterRevocation(stored: StoredDelegation, r: { list: CredentialStatusList; published: boolean }): StoredDelegation {
  return r.published
    ? { ...stored, revoked: true, revocationPending: undefined }
    : { ...stored, revocationPending: { sequence: r.list.sequence } }
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
  const [busy, setBusy] = useState<'' | 'issue' | 'anchor' | 'unanchor' | 'revoke' | 'confirm'>('')
  const [imported, setImported] = useState<CredentialStatusList | null>(null)
  const [needImport, setNeedImport] = useState(false)
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

  /** anchor() / unanchor(): only after the anchor checks out (code + bound to this manager). */
  const sendAnchorTx = async (kind: 'anchor' | 'unanchor') => {
    const anchor = getSessionAnchor(signer as never, chainId)
    if (!anchor || !stored) return
    try {
      setBusy(kind)
      const problem = await sessionAnchorProblem(anchor as never, sessionManager)
      if (problem) {
        notify(t.sessions.delegation.anchorProblem[problem], false)
        return
      }
      const tx = (await anchor[kind](session.id, stored.credentialHash)) as { wait(): Promise<unknown>; hash: string }
      await tx.wait()
      onStored(kind === 'anchor' ? { ...stored, anchoredTx: tx.hash } : { ...stored, anchoredTx: undefined })
      notify(kind === 'anchor' ? t.sessions.delegation.anchoredToast : t.sessions.delegation.unanchoredToast, true, tx.hash)
      await refresh()
    } catch (e) {
      notify(prettyError(e), false)
    } finally {
      setBusy('')
    }
  }

  const revoke = async (confirmedNoPublishedList = false) => {
    if (!signer || !stored) return
    if (confirmedNoPublishedList && !window.confirm(t.sessions.delegation.confirmNoListPrompt)) return
    try {
      setBusy('revoke')
      const r = await revokeDelegationCredential({
        signer,
        user: userAddress,
        sessionManager,
        credential: stored.credential,
        imported,
        confirmedNoPublishedList,
      })
      setNeedImport(false)
      onStored(afterRevocation(stored, r))
      notify(
        interpolate(r.published ? t.sessions.delegation.revokedPublished : t.sessions.delegation.revokedDownloaded, {
          seq: String(r.list.sequence),
        }),
        true,
      )
    } catch (e) {
      setNeedImport(true)
      notify(prettyError(e), false)
    } finally {
      setBusy('')
    }
  }

  /** Pending revocation → revoked, once the published list carries it. */
  const confirmPublished = async () => {
    if (!stored) return
    try {
      setBusy('confirm')
      if (await isRevocationPublished(userAddress, sessionManager, stored.credential)) {
        onStored({ ...stored, revoked: true, revocationPending: undefined })
        notify(t.sessions.delegation.revocationConfirmed, true)
      } else {
        notify(t.sessions.delegation.revocationNotYetPublished, false)
      }
    } finally {
      setBusy('')
    }
  }

  const importList = async (file: File | undefined) => {
    if (!file) return
    try {
      const list = JSON.parse(await file.text()) as CredentialStatusList
      const problem = statusListProblem(list, userAddress, sessionManager)
      if (problem) throw new Error(problem)
      setImported(list)
      notify(interpolate(t.sessions.delegation.importedList, { seq: String(list.sequence) }), true)
    } catch (e) {
      notify(interpolate(t.sessions.delegation.importFailed, { reason: (e as Error).message }), false)
    }
  }

  const d = t.sessions.delegation
  const vc = stored?.credential
  const expired = vc ? Date.parse(vc.validUntil) < Date.now() : false
  const status = session.revoked
    ? { label: d.statusSessionRevoked, color: 'default' as const }
    : stored?.revoked
      ? { label: d.statusRevoked, color: 'error' as const }
      : stored?.revocationPending
        ? { label: interpolate(d.statusRevokePending, { seq: String(stored.revocationPending.sequence) }), color: 'warning' as const }
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
            {anchorDeployed && !anchored && !stored.revoked && !stored.revocationPending && !session.revoked && (
              <Button variant="contained" onClick={() => void sendAnchorTx('anchor')} disabled={busy !== ''} sx={{ textTransform: 'none' }}>
                {busy === 'anchor' ? d.anchoring : d.anchor}
              </Button>
            )}
            {anchorDeployed && anchored && (
              <Button variant="outlined" color="warning" onClick={() => void sendAnchorTx('unanchor')} disabled={busy !== '' || !signer} sx={{ textTransform: 'none' }}>
                {busy === 'unanchor' ? d.unanchoring : d.unanchor}
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
            {stored.revocationPending && (
              <Button variant="contained" color="warning" onClick={() => void confirmPublished()} disabled={busy !== ''} sx={{ textTransform: 'none' }}>
                {busy === 'confirm' ? d.confirmingPublished : d.confirmPublished}
              </Button>
            )}
            {!stored.revoked && (
              <Button variant="outlined" color="error" onClick={() => void revoke()} disabled={busy !== '' || !signer} sx={{ textTransform: 'none' }}>
                {busy === 'revoke' ? d.revoking : stored.revocationPending ? d.revokeAgain : d.revoke}
              </Button>
            )}
          </Stack>
          {stored.revocationPending && <Alert severity="warning">{d.revokePendingNote}</Alert>}
          {needImport && !stored.revoked && (
            <Alert severity="info">
              {d.importHint}{' '}
              <Button component="label" size="small" sx={{ textTransform: 'none' }}>
                {imported ? interpolate(d.importedList, { seq: String(imported.sequence) }) : d.importList}
                <input hidden type="file" accept="application/json,.json" onChange={(e) => void importList(e.target.files?.[0])} />
              </Button>
              {!imported && (
                <Button size="small" color="warning" onClick={() => void revoke(true)} disabled={busy !== '' || !signer} sx={{ textTransform: 'none' }}>
                  {d.confirmNoList}
                </Button>
              )}
            </Alert>
          )}
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

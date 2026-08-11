// App-wide notification + confirmation layer.
//
// WHY THIS EXISTS
//
// Fourteen pages each declared their own `const [toast, setToast] = useState(...)`
// plus a local `notify()` and their own <Snackbar>. Same shape every time, so
// the duplication was survivable — but it had a consequence that was not:
// a *component* had no way to reach a *page's* local state. So the two
// components that needed to say something to the user (the GameFi lab, since
// made a page, and the retired loot box) fell back to `window.alert()` and
// `window.confirm()` — twelve calls in total.
//
// Native dialogs are the single loudest "this is not a finished product" signal
// on a financial surface: they are OS-chrome, unstyled, unbranded, they block
// the entire main thread, they cannot show a transaction hash, and on mobile
// they are indistinguishable from a browser warning. Swapping them for a styled
// snackbar without fixing the reachability problem would just move the
// duplication into those components, so the provider is the actual fix.
//
// `notify(msg, ok, hash?)` intentionally mirrors the signature the pages
// already use, so migrating one is deleting its local state and importing this.

import { useState, useMemo, useCallback, useContext, createContext } from 'react';

import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import Snackbar from '@mui/material/Snackbar';
import DialogTitle from '@mui/material/DialogTitle';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';

// useWalletContext, not useWallet: the latter builds its own useState and would
// spin up a second, independent wallet instance. This provider sits inside
// <WalletProvider>, so it reads the shared one. (usePepefiWallet is not an
// option either — it reads the router outlet context, which does not exist this
// far up the tree.)
import { useWalletContext } from 'src/contexts/wallet-context';

import { explorerTx, explorerName } from 'src/lib/pepefi/notify';

// ----------------------------------------------------------------------

export type ConfirmOptions = {
  title: string;
  message: string;
  /** Label for the affirmative button. Say what it does — "Buy", "Switch",
   *  not "OK". A user reading only the button should still know the outcome. */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Renders the affirmative button in the danger colour and gives the cancel
   *  button the visual weight instead. */
  destructive?: boolean;
};

type ToastContextValue = {
  /** Show a transient message. `hash` adds a block-explorer link. */
  notify: (msg: string, ok: boolean, hash?: string) => void;
  /** Promise-based replacement for window.confirm — resolves true on confirm. */
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
};

const ToastContext = createContext<ToastContextValue | null>(null);

/** Throws when used outside the provider rather than silently no-oping, so a
 *  missed mount surfaces in development instead of swallowing user feedback. */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
}

// ----------------------------------------------------------------------

type ToastState = { msg: string; ok: boolean; hash?: string };
type DialogState = ConfirmOptions & { resolve: (v: boolean) => void };

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const wallet = useWalletContext();

  const notify = useCallback((msg: string, ok: boolean, hash?: string) => {
    setToast({ msg, ok, hash });
  }, []);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setDialog({ ...opts, resolve });
      }),
    []
  );

  // Settling the promise and closing are one action: if the dialog closed
  // without resolving, every `await confirm(...)` would hang forever and the
  // caller's button would stay in its loading state.
  const settle = useCallback(
    (value: boolean) => {
      setDialog((d) => {
        d?.resolve(value);
        return null;
      });
    },
    []
  );

  const value = useMemo(() => ({ notify, confirm }), [notify, confirm]);

  const txUrl = toast?.hash ? explorerTx(toast.hash, wallet.chainId) : null;

  return (
    <ToastContext.Provider value={value}>
      {children}

      <Snackbar
        open={!!toast}
        // 6s: long enough to read a two-line Chinese message and reach for the
        // explorer link, short enough not to sit over the UI.
        autoHideDuration={6000}
        onClose={(_, reason) => {
          // Not on clickaway — a stray click elsewhere should not destroy a
          // transaction hash the user was about to open.
          if (reason !== 'clickaway') setToast(null);
        }}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <Alert
          severity={toast?.ok ? 'success' : 'error'}
          variant="filled"
          onClose={() => setToast(null)}
          // Announced by screen readers without moving focus, so a toast never
          // interrupts what the user is typing.
          role="status"
          sx={{ alignItems: 'center', maxWidth: 420 }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <span>{toast?.msg}</span>
            {txUrl && (
              <Button
                size="small"
                color="inherit"
                component="a"
                href={txUrl}
                target="_blank"
                rel="noopener noreferrer"
                sx={{ textDecoration: 'underline', minHeight: 32 }}
              >
                {explorerName(wallet.chainId)}
              </Button>
            )}
          </Box>
        </Alert>
      </Snackbar>

      <Dialog
        open={!!dialog}
        // Escape and backdrop both cancel: a confirmation the user can only
        // escape by choosing an option is a trap.
        onClose={() => settle(false)}
        aria-labelledby="pepefi-confirm-title"
        aria-describedby="pepefi-confirm-message"
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle id="pepefi-confirm-title">{dialog?.title}</DialogTitle>
        <DialogContent>
          <DialogContentText id="pepefi-confirm-message">{dialog?.message}</DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
          <Button onClick={() => settle(false)} color="inherit" variant="text">
            {dialog?.cancelLabel ?? '取消'}
          </Button>
          <Button
            onClick={() => settle(true)}
            color={dialog?.destructive ? 'error' : 'primary'}
            variant="contained"
            autoFocus={!dialog?.destructive}
          >
            {dialog?.confirmLabel ?? '確認'}
          </Button>
        </DialogActions>
      </Dialog>
    </ToastContext.Provider>
  );
}

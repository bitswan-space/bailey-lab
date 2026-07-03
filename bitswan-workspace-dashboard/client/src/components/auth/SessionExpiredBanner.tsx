import { useEffect, useState } from 'react';
import { LogIn, AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { subscribeSessionExpired } from '@/lib/session';
import { interactiveSignIn } from '@/lib/signin';

// Shown when the oauth2-proxy session expires mid-use (the api layer raises the
// session-expired signal on a 401 that survives a token refresh). A single,
// app-wide banner — NOT a per-feature error — so an expired session reads as
// "log in again", never as "your deploy/snapshot/etc. failed". Reuses the same
// sign-in flow as the first-login gate.
export function SessionExpiredBanner() {
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => subscribeSessionExpired(() => setShown(true)), []);

  if (!shown) return null;

  async function logIn() {
    setBusy(true);
    setError(null);
    const err = await interactiveSignIn();
    if (err) {
      setError(err);
      setBusy(false);
      return;
    }
    // Re-authed: reload so every view + poll picks up the fresh session.
    window.location.reload();
  }

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-[100] flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-amber-500/40 bg-amber-500/15 px-4 py-2 text-sm text-amber-900 shadow-sm backdrop-blur dark:text-amber-100"
    >
      <span className="flex items-center gap-2 font-medium">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        Your session expired.
      </span>
      <span className="text-amber-900/80 dark:text-amber-100/80">
        Log in again to keep working — anything already running keeps running.
      </span>
      {error ? (
        <span className="text-destructive">{error}</span>
      ) : null}
      <Button size="sm" onClick={logIn} disabled={busy}>
        <LogIn />
        {busy ? 'Signing in…' : 'Log in'}
      </Button>
    </div>
  );
}

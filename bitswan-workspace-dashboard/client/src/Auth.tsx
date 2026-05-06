import { useEffect, useState, type ReactNode } from 'react';
import { LogIn } from 'lucide-react';

import { Button } from '@/components/ui/button';

type AuthState =
  | { status: 'loading' }
  | { status: 'authed' }
  | { status: 'signin'; error?: string }
  | { status: 'in-progress'; message: string };

async function checkAuth(): Promise<boolean> {
  try {
    const r = await fetch('/oauth2/auth', {
      credentials: 'include',
      cache: 'no-store',
    });
    return r.status === 200 || r.status === 202;
  } catch {
    return false;
  }
}

function waitForLoginDone(popup: Window): Promise<void> {
  return new Promise((resolve, reject) => {
    const expectedOrigin = window.location.origin;
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== expectedOrigin) return;
      if (ev.data === 'login-done') {
        cleanup();
        resolve();
      }
    };
    const checkClosed = window.setInterval(() => {
      if (popup.closed) {
        cleanup();
        reject(new Error('popup closed before completion'));
      }
    }, 500);
    const timeout = window.setTimeout(() => {
      cleanup();
      try {
        popup.close();
      } catch {
        // ignore
      }
      reject(new Error('sign-in timed out'));
    }, 5 * 60 * 1000);
    function cleanup() {
      window.removeEventListener('message', onMessage);
      window.clearInterval(checkClosed);
      window.clearTimeout(timeout);
    }
    window.addEventListener('message', onMessage);
  });
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    checkAuth().then((authed) => {
      if (cancelled) return;
      setState(authed ? { status: 'authed' } : { status: 'signin' });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function startSignIn() {
    if (typeof document.requestStorageAccess !== 'function') {
      setState({
        status: 'signin',
        error:
          'This browser does not support the Storage Access API. Open the dashboard in a new tab instead.',
      });
      return;
    }

    setState({ status: 'in-progress', message: 'Requesting cookie permission…' });

    try {
      await document.requestStorageAccess();
    } catch {
      setState({
        status: 'signin',
        error:
          'Permission denied. The dashboard needs cookie access to authenticate inside this page. Try again and allow the prompt, or open in a new tab.',
      });
      return;
    }

    setState({ status: 'in-progress', message: 'Checking session…' });
    if (await checkAuth()) {
      setState({ status: 'authed' });
      return;
    }

    setState({ status: 'in-progress', message: 'Opening sign-in popup…' });
    const popup = window.open(
      '/oauth2/start?rd=/_login_done',
      'workspace-dashboard-login',
      'width=500,height=700',
    );
    if (!popup) {
      setState({
        status: 'signin',
        error: 'Popup was blocked. Please allow popups for this page and try again.',
      });
      return;
    }

    setState({
      status: 'in-progress',
      message: 'Waiting for sign-in to complete…',
    });
    try {
      await waitForLoginDone(popup);
    } catch {
      setState({
        status: 'signin',
        error: 'Sign-in was cancelled. Try again to retry.',
      });
      return;
    }

    window.location.reload();
  }

  if (state.status === 'authed') {
    return <>{children}</>;
  }

  return (
    <div className="grid h-screen place-items-center bg-background p-6">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-sm">
        {state.status === 'loading' ? (
          <p className="text-center text-sm text-muted-foreground">Loading…</p>
        ) : state.status === 'in-progress' ? (
          <div className="space-y-3 text-center">
            <h2 className="text-lg font-semibold text-card-foreground">
              Signing in…
            </h2>
            <p className="text-sm text-card-foreground">{state.message}</p>
            <p className="text-xs text-muted-foreground">
              If your browser shows a permission prompt, please allow it.
            </p>
          </div>
        ) : (
          <div className="space-y-4 text-center">
            <h2 className="text-lg font-semibold text-card-foreground">
              Sign in to Workspace Dashboard
            </h2>
            <p className="text-sm text-card-foreground">
              Click <strong>Sign in</strong> below. Your browser may show a
              permission prompt asking the dashboard to use its cookies on this
              page — <strong>please allow it</strong>. A small popup will then
              open briefly to complete sign-in.
            </p>
            {state.error ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-left text-sm text-destructive">
                {state.error}
              </div>
            ) : null}
            <div className="flex justify-center pt-2">
              <Button onClick={startSignIn}>
                <LogIn />
                Sign in
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

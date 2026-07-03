import { useEffect, useState, type ReactNode } from 'react';
import { LogIn } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { checkAuth, interactiveSignIn } from '@/lib/signin';

type AuthState =
  | { status: 'loading' }
  | { status: 'authed' }
  | { status: 'signin'; error?: string }
  | { status: 'in-progress'; message: string };

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
    const error = await interactiveSignIn((message) =>
      setState({ status: 'in-progress', message }),
    );
    if (error) {
      setState({ status: 'signin', error });
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

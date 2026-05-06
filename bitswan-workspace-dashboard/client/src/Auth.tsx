import { useEffect, useState, type ReactNode } from 'react';

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

    setState({
      status: 'in-progress',
      message: 'Opening sign-in popup…',
    });
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

  if (state.status === 'loading') {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <p>Loading…</p>
        </div>
      </div>
    );
  }

  if (state.status === 'authed') {
    return <>{children}</>;
  }

  if (state.status === 'in-progress') {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h2>Signing in…</h2>
          <p>{state.message}</p>
          <p className="auth-hint">
            If your browser shows a permission prompt, please allow it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <h2>Sign in to Workspace Dashboard</h2>
        <p>
          Click <strong>Sign in</strong> below. Your browser may show a permission
          prompt asking the dashboard to use its cookies on this page —{' '}
          <strong>please allow it</strong>. A small popup will then open briefly
          to complete sign-in.
        </p>
        {state.error ? <p className="auth-error">{state.error}</p> : null}
        <button className="auth-button" onClick={startSignIn}>
          Sign in
        </button>
      </div>
    </div>
  );
}

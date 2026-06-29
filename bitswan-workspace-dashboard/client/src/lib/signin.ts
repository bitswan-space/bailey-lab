// The interactive re-auth flow, shared by the first-login gate (AuthGate) and
// the session-expired banner (SessionExpiredBanner) so there is exactly ONE
// proven path through the third-party-iframe cookie dance + sign-in popup.

export async function checkAuth(): Promise<boolean> {
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
    const timeout = window.setTimeout(
      () => {
        cleanup();
        try {
          popup.close();
        } catch {
          // ignore
        }
        reject(new Error('sign-in timed out'));
      },
      5 * 60 * 1000,
    );
    function cleanup() {
      window.removeEventListener('message', onMessage);
      window.clearInterval(checkClosed);
      window.clearTimeout(timeout);
    }
    window.addEventListener('message', onMessage);
  });
}

export type SignInProgress = (message: string) => void;

/** Run the interactive sign-in. Resolves to `null` on success, or a
 *  human-readable error string the caller should surface. Reports progress
 *  via the optional callback. */
export async function interactiveSignIn(
  onProgress?: SignInProgress,
): Promise<string | null> {
  if (typeof document.requestStorageAccess !== 'function') {
    return 'This browser does not support the Storage Access API. Open the dashboard in a new tab instead.';
  }

  onProgress?.('Requesting cookie permission…');
  try {
    await document.requestStorageAccess();
  } catch {
    return 'Permission denied. The dashboard needs cookie access to authenticate inside this page. Try again and allow the prompt, or open in a new tab.';
  }

  onProgress?.('Checking session…');
  if (await checkAuth()) return null;

  onProgress?.('Opening sign-in popup…');
  const popup = window.open(
    '/oauth2/start?rd=/_login_done',
    'workspace-dashboard-login',
    'width=500,height=700',
  );
  if (!popup) {
    return 'Popup was blocked. Please allow popups for this page and try again.';
  }

  onProgress?.('Waiting for sign-in to complete…');
  try {
    await waitForLoginDone(popup);
  } catch {
    return 'Sign-in was cancelled. Try again to retry.';
  }

  return null;
}

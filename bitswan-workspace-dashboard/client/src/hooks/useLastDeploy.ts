import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, type BpLastDeploy } from '@/lib/api';
import { SessionExpiredError } from '@/lib/session';

interface Result {
  // eslint-disable-next-line no-restricted-syntax
  lastDeploy: BpLastDeploy | null | undefined;
  error: string;
  refresh: () => Promise<void>;
}

export function useLastDeploy(
  bp: string,
  stage: string,
  copy?: string,
  nonce = 0,
): Result {
  // eslint-disable-next-line no-restricted-syntax
  const [lastDeploy, setLastDeploy] = useState<BpLastDeploy | null | undefined>(
    undefined,
  );
  const [error, setError] = useState('');
  const aliveRef = useRef(true);
  const askedRef = useRef('');
  const key = `${bp} ${stage} ${copy ?? ''}`;
  askedRef.current = key;

  const refresh = useCallback(async () => {
    const asked = key;
    try {
      const r = await api.bpLastDeploy(bp, stage, copy);
      if (!aliveRef.current || askedRef.current !== asked) return;
      setLastDeploy(r);
      setError('');
    } catch (err) {
      if (!aliveRef.current || askedRef.current !== asked) return;
      if (err instanceof SessionExpiredError) return;
      setError(errorMessage(err));
    }
  }, [bp, stage, copy, key]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    setLastDeploy(undefined);
  }, [key]);

  useEffect(() => {
    void refresh();
  }, [refresh, nonce]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  return { lastDeploy, error, refresh };
}

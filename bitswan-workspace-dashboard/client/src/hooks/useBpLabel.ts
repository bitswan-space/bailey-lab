import { useCallback } from 'react';
import { useProcesses } from '@/components/workspace/WorkspaceProvider';

/**
 * Resolve a business-process DIRECTORY SLUG to the name a person should read.
 *
 * A business process has two names and they are not interchangeable:
 *
 *   `name` / `id`   the directory and git-repo slug — `test33`. An IDENTIFIER:
 *                   it goes in API paths, deployment ids and toast dedupe keys,
 *                   and it never changes when the process is renamed.
 *   `displayName`   what the process is called — `Compost`. The only one a
 *                   user has ever agreed to.
 *
 * Renaming a process changes only the second, so any screen that prints the
 * slug starts contradicting the rest of the app the moment somebody renames
 * anything. Reported by a user: "Why when I am in the compost BP is it showing
 * me a sync tab with info about test33?" — the Sync tab was right about the
 * process and wrong about its name.
 *
 * Server APIs answer in slugs (they are keys), so anything rendering a value
 * that came back from gitops has to come through here first.
 *
 * When the processes feed doesn't carry the slug — it hasn't arrived yet, or
 * the process lives only in someone else's copy — the slug is returned as-is.
 * That is not a guess: there is no display name to show, and the identifier is
 * the only true thing left to print.
 */
export function useBpLabel(): (slug: string) => string {
  const { processes } = useProcesses();
  return useCallback(
    (slug: string) => {
      const p = (processes ?? []).find((b) => b.id === slug || b.name === slug);
      return p?.displayName || p?.name || slug;
    },
    [processes],
  );
}

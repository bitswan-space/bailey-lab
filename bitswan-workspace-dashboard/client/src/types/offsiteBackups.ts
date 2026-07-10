// Workspace-level off-site (restic) backup types. Shapes mirror gitops's
// /backups router (bitswan-gitops/app/routes/backups.py), proxied at
// /api/offsite-backups/*.

export interface OffsiteLastRun {
  started_at: string;
  finished_at: string;
  ok: boolean;
  results: Record<
    string,
    { success?: boolean; output?: string } | string | undefined
  >;
}

/** `GET /api/offsite-backups/config` response. */
export interface OffsiteBackupConfig {
  configured: boolean;
  aoc_connected?: boolean;
  enabled?: boolean;
  retention?: { daily?: number; monthly?: number };
  has_key?: boolean;
  last_run?: OffsiteLastRun | null;
  running?: boolean;
}

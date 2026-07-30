// A *partial* view over `docker inspect` output. Only the fields the Inspect
// modal renders are declared; everything else is tolerated. Field names use
// Docker's PascalCase exactly as they come off the socket.
//
// gitops projects the raw inspect record down to these fields server-side
// (`_project_inspect` in automation_service.py) so no unmasked env crosses the
// wire. A container whose inspect call FAILED degrades to docker's flat
// `/containers/json` LIST shape instead — `Names: ["/x"]`, `State: "running"`,
// `Created: <unix seconds>`, `Labels` at the top level — so the fields that
// differ between the two shapes are typed as a union and read through the
// accessors in docker-inspect-rows.tsx.

/* eslint-disable no-restricted-syntax -- wire-mirror nullable fields match Docker's JSON shape */

export interface DockerInspect {
  Id?: string;
  Name?: string;
  /** Container-list shape only (`docker inspect` uses the singular `Name`). */
  Names?: string[];
  /** RFC3339 in the inspect shape; Unix **seconds** in the container-list shape. */
  Created?: string | number;
  RestartCount?: number;
  /** An object in the inspect shape; a bare state string in the list shape. */
  State?:
    | {
        Status?: string;
        Running?: boolean;
        Pid?: number;
        Health?: {
          Status?: string;
          FailingStreak?: number;
        };
      }
    | string;
  Image?: string;
  /** Container-list shape only (`docker inspect` nests these under `Config`). */
  Labels?: Record<string, string>;
  Config?: {
    Image?: string;
    Hostname?: string;
    Labels?: Record<string, string>;
    Healthcheck?: {
      Test?: string[];
      Interval?: number;
    };
  };
  HostConfig?: {
    NanoCpus?: number;
    Memory?: number;
    NetworkMode?: string;
  };
  NetworkSettings?: {
    Networks?: Record<string, { IPAddress?: string }>;
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
  Mounts?: Array<{
    Type?: string;
    Source?: string;
    Destination?: string;
    Mode?: string;
    RW?: boolean;
  }>;
  /**
   * Container env, pre-masked SERVER-SIDE by gitops: `value` is already
   * `****` when the viewer's role may not see a secret (production secrets
   * are admin/auditor-only). The client only renders what it receives.
   */
  Env?: Array<{
    name?: string;
    value?: string;
    secret?: boolean;
    masked?: boolean;
  }>;
}

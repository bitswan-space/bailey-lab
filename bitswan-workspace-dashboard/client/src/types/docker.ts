// A *partial* view over `docker inspect` output. Only the fields the Inspect
// modal renders are declared; everything else is tolerated. Field names use
// Docker's PascalCase exactly as they come off the socket.

/* eslint-disable no-restricted-syntax -- wire-mirror nullable fields match Docker's JSON shape */

export interface DockerInspect {
  Id?: string;
  Name?: string;
  Created?: string;
  RestartCount?: number;
  State?: {
    Status?: string;
    Pid?: number;
    Health?: {
      Status?: string;
      FailingStreak?: number;
    };
  };
  Image?: string;
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
}

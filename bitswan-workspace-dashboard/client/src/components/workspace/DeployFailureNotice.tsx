import { TriangleAlert } from 'lucide-react';
import type { BpLastDeploy } from '@/lib/api';

interface CauseCopy {
  heading: string;
  body: string;
  fix: string;
}

const CAUSE_COPY: Record<string, CauseCopy> = {
  disk_full: {
    heading: 'The server ran out of disk space',
    body: 'Your work is published to the main code area, but it is not running: the deploy could not create this business process’s database because the server has no disk space left.',
    fix: 'Free some space on the server, then deploy again with the button above. Nothing you did needs redoing — the retry picks up exactly the version you published.',
  },
};

const UNCLASSIFIED: CauseCopy = {
  heading: 'The last deploy failed',
  body: 'Your work is published to the main code area, but it is not running.',
  fix: 'Fix what the error below reports, then deploy again with the button above. The retry picks up exactly the version you published.',
};

const STEP_LABEL: Record<string, string> = {
  building_images: 'building the images',
  updating_config: 'updating the deployment configuration',
  enabling_services: 'enabling the services',
  generating_compose: 'generating the compose project',
  reconciling_ingress: 'reconciling the ingress routes',
  docker_compose_up: 'starting the containers',
  provisioning_services: 'provisioning the databases and buckets',
  installing_certs: 'installing the CA certificates',
  storing_tags: 'storing the image tags',
  deploying: 'deploying',
};

function whenText(at?: string): string {
  if (!at) return '';
  const t = new Date(at);
  return Number.isNaN(t.getTime()) ? '' : t.toLocaleString();
}

export function DeployFailureNotice({
  lastDeploy,
  stageLabel,
}: {
  lastDeploy: BpLastDeploy;
  stageLabel: string;
}) {
  const copy = CAUSE_COPY[lastDeploy.cause ?? ''] ?? UNCLASSIFIED;
  const step = STEP_LABEL[lastDeploy.step ?? ''];
  const when = whenText(lastDeploy.at);

  return (
    <div className="shrink-0 border-b border-red-200 bg-red-50 px-7 py-5">
      <div className="flex items-start gap-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-red-100">
          <TriangleAlert className="size-4 text-red-700" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-bold tracking-tight text-red-800">
            {copy.heading}
          </div>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-red-900/90">
            {copy.body}
          </p>
          <p className="mt-2 max-w-2xl text-[13px] font-medium leading-relaxed text-red-900">
            {copy.fix}
          </p>
          <div className="mt-2.5 text-[11px] font-semibold uppercase tracking-wide text-red-700/80">
            Deploy to {stageLabel}
            {step ? ` failed while ${step}` : ' failed'}
            {when ? ` — ${when}` : ''}
          </div>
          {lastDeploy.error && (
            <pre className="mt-2 max-h-40 max-w-3xl overflow-auto whitespace-pre-wrap break-words rounded-md border border-red-200 bg-white p-3 font-mono text-[12px] leading-relaxed text-red-900">
              {lastDeploy.error}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

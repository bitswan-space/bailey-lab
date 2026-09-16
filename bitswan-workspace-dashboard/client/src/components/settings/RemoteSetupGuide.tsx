import { useState } from 'react';
import { BookOpen, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

type Provider = 'github' | 'gitlab' | 'other';

interface RemoteSetupGuideProps {
  provider?: Provider;
}

const PROVIDERS: Provider[] = ['github', 'gitlab', 'other'];

const GUIDES: Record<Provider, { label: string; url: string; steps: { title: string; body: string }[] }> = {
  github: {
    label: 'GitHub',
    url: 'git@github.com:<org>/<repo>.git',
    steps: [
      {
        title: 'Create the repository',
        body: 'Create an empty repository in your organisation. A README, licence or .gitignore that GitHub adds is kept; Bailey only manages the business-process folders and adds its own README when there is none.',
      },
      {
        title: 'Add the deploy key with write access',
        body: 'Repository → Settings → Deploy keys → Add deploy key. Paste the public key shown above, give it a title such as the workspace name, and tick “Allow write access”. Each workspace has its own key, so add one per workspace.',
      },
      {
        title: 'Make main fast-forward only',
        body: 'Repository → Settings → Rules → Rulesets → New branch ruleset. Target the default branch (main), enable “Block force pushes” and “Restrict deletions”, leave the bypass list empty so the rule binds everyone — administrators included — and save it as active. Do not enable “Require a pull request before merging”: Bailey pushes to main directly. If you ever need Bailey to force push to repair, disable the ruleset for the moment of the repair.',
      },
      {
        title: 'Set the remote here',
        body: 'Copy the SSH clone URL — it looks like git@github.com:<org>/<repo>.git — paste it above and Save. The first push follows immediately.',
      },
      {
        title: 'Check the default branch',
        body: 'Into an empty repository Bailey pushes main first and alone, so GitHub makes it the default branch. If the repository already had another default, switch it to main under Settings → General → Default branch.',
      },
    ],
  },
  gitlab: {
    label: 'GitLab',
    url: 'git@gitlab.com:<group>/<project>.git',
    steps: [
      {
        title: 'Create the project',
        body: 'Create a blank project in your group. An initial README is kept; Bailey adds its own README only when there is none.',
      },
      {
        title: 'Add the deploy key with write access',
        body: 'Project → Settings → Repository → Deploy keys → Add new key. Paste the public key shown above, give it a title, and tick “Grant write permissions to this key”.',
      },
      {
        title: 'Make main fast-forward only',
        body: 'Project → Settings → Repository → Protected branches → protect main with “Allowed to force push” switched off. That switch binds everyone — maintainers and owners too — so nobody can rewrite main. Under “Allowed to push and merge” add the deploy key you just added (deploy keys are listed there), otherwise the protection rejects Bailey’s own fast-forward pushes. Keep merge requests optional. If you ever need Bailey to force push to repair, allow force push for the moment of the repair.',
      },
      {
        title: 'Set the remote here',
        body: 'Copy the SSH clone URL — it looks like git@gitlab.com:<group>/<project>.git — paste it above and Save.',
      },
      {
        title: 'Check the default branch',
        body: 'Into an empty project Bailey pushes main first and alone, so GitLab makes it the default branch. If the project already had another default, switch it to main under Settings → Repository → Branch defaults.',
      },
    ],
  },
  other: {
    label: 'Other hosts',
    url: 'ssh://git@host/path/repo.git',
    steps: [
      {
        title: 'Create an empty repository',
        body: 'Any host reachable over SSH works, including a bare repository on a server of your own.',
      },
      {
        title: 'Register the public key',
        body: 'Add the public key shown above as a deploy key or authorized key with permission to push.',
      },
      {
        title: 'Protect main if the host can',
        body: 'Forgejo, Gitea and Bitbucket all offer branch protection; block force pushes and deletions on main so it stays fast-forward only, which is what Bailey relies on.',
      },
      {
        title: 'Set the remote here',
        body: 'Use the SSH URL (git@host:path/repo.git or ssh://git@host:port/path/repo.git). HTTPS remotes are not accepted.',
      },
      {
        title: 'Check the default branch',
        body: 'Bailey pushes main first and alone into an empty repository, which most hosts take as the default branch. A bare repository of your own needs `git symbolic-ref HEAD refs/heads/main`; hosted repositories have a default-branch setting.',
      },
    ],
  },
};

export function RemoteSetupGuide({ provider }: RemoteSetupGuideProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Provider>(provider ?? 'github');
  const guide = GUIDES[tab];

  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-medium text-foreground hover:bg-muted/60"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />
        )}
        <BookOpen className="size-3.5 text-primary" aria-hidden />
        How to set up the remote, the deploy key, and a fast-forward-only main
      </button>
      {open && (
        <div className="border-t border-border px-3 py-3">
          <p className="mb-3 text-[12px] text-muted-foreground">
            Main must stay fast-forward only: Bailey pushes it as a fast-forward and pulls commits
            added on top of it. Where your git host can block force pushes on main, turn that on.
          </p>
          <div className="mb-3 flex flex-wrap gap-1">
            {PROVIDERS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-[12px] transition-colors',
                  tab === key
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:bg-muted/60',
                )}
              >
                {GUIDES[key].label}
              </button>
            ))}
          </div>
          <ol className="space-y-2.5 pl-5 text-[12px] leading-relaxed text-foreground">
            {guide.steps.map((step) => (
              <li key={step.title} className="list-decimal">
                <span className="font-semibold">{step.title}.</span>{' '}
                <span className="text-muted-foreground">{step.body}</span>
              </li>
            ))}
          </ol>
          <p className="mt-3 font-mono text-[11px] text-muted-foreground">{guide.url}</p>
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';

import { useCopyIdentity } from '@/lib/identity';
import { cn } from '@/lib/utils';

function initialsOf(text: string): string {
  const parts = (text || '').split(/[\s@._-]+/).filter(Boolean);
  return (
    ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() ||
    (text[0] ?? '?').toUpperCase()
  );
}

function IdAvatar({
  name,
  avatar,
  size,
}: {
  name: string;
  // eslint-disable-next-line no-restricted-syntax -- null = no avatar
  avatar: string | null;
  size: number;
}) {
  const [ok, setOk] = useState(!!avatar);
  useEffect(() => setOk(!!avatar), [avatar]);
  const style = { width: size, height: size };
  if (avatar && ok) {
    return (
      <img
        src={avatar}
        alt=""
        style={style}
        onError={() => setOk(false)}
        className="shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span
      style={style}
      className="flex shrink-0 items-center justify-center rounded-full bg-primary/15 text-[9px] font-semibold text-primary"
    >
      {initialsOf(name)}
    </span>
  );
}

/**
 * Renders a copy as its owner's identity — real name + avatar resolved from the
 * AOC directory (by forward-matching the slug). Falls back to the raw slug (in
 * mono, as before) when the owner isn't a known user, so nothing is ever blank.
 */
export function CopyIdentity({
  slug,
  variant = 'full',
  className,
  avatarSize = 20,
}: {
  slug: string;
  variant?: 'full' | 'name';
  className?: string;
  avatarSize?: number;
}) {
  const id = useCopyIdentity(slug);
  // A resolved email means this is a real user (a per-user copy). Show their
  // name if set, otherwise their email — never the weird slug. Only a truly
  // unresolved (custom) copy falls back to the raw slug (in mono).
  const known = !!id?.email;
  const label = id?.name || id?.email || slug;
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2', className)}>
      {variant === 'full' && (
        <IdAvatar name={label} avatar={id?.avatar ?? null} size={avatarSize} />
      )}
      <span
        title={id?.email || slug}
        className={cn(
          'min-w-0 truncate text-[13px]',
          known ? 'font-medium text-foreground' : 'font-mono',
        )}
      >
        {label}
      </span>
    </span>
  );
}

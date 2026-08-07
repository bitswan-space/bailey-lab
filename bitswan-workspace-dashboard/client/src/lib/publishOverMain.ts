/**
 * The pure decisions behind "Deploy this version, overwriting main".
 *
 * Kept out of the component so they can be tested without a browser: what the
 * dialog claims about other people's work, and when the confirm button is
 * allowed to be pressed, are the two things that make the button safe.
 */

/** One superseded commit, as the preview endpoint returns it. */
export interface SupersededCommit {
  sha: string;
  subject: string;
  /** Email, or the name when git recorded no email. */
  author: string;
  author_name: string;
  date: string;
}

/** How a copy may be published over a main that moved on. */
export type PublishMode = 'rebase' | 'exact';

/**
 * "3 commits by 2 people (Ada Lovelace, Bo Chen)".
 *
 * The count of PEOPLE is the part that changes how the sentence reads, so it
 * is counted rather than implied by listing names — one colleague and four are
 * very different decisions. Authors are de-duplicated on the email git
 * recorded (names get typed inconsistently), and named in the order their
 * commits appear.
 */
export function describeSuperseded(commits: SupersededCommit[]): string {
  if (commits.length === 0) return 'nothing — main has no commits your copy lacks';
  const seen = new Set<string>();
  const names: string[] = [];
  for (const c of commits) {
    const key = (c.author || c.author_name || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(c.author_name || c.author);
  }
  const commitPart = `${commits.length} commit${commits.length === 1 ? '' : 's'}`;
  const peoplePart = `${names.length} ${names.length === 1 ? 'person' : 'people'}`;
  return `${commitPart} by ${peoplePart} (${names.join(', ')})`;
}

/**
 * What the two modes actually do, in one line each — the difference the user
 * is being asked to choose between, not a restatement of their names.
 */
export const PUBLISH_MODE_SUMMARY: Record<PublishMode, string> = {
  rebase:
    'Your version wins wherever you both changed the same thing. Anything main added that you never touched is kept.',
  exact:
    'Main ends up holding exactly what your copy holds — including dropping anything main added that you do not have.',
};

/**
 * Whether the confirm button may be pressed.
 *
 * The typed phrase is the business process's own slug, matching the guard rail
 * the snapshot dialogs use for a production target: enough friction that this
 * cannot be a mis-click, and no friction at all for someone who meant it.
 * Whitespace is forgiven, case is not — the slug is lowercase everywhere else
 * in the product and accepting `Compost` would teach the wrong shape.
 */
export function publishConfirmed(typed: string, bpSlug: string): boolean {
  return typed.trim() === bpSlug;
}

/**
 * Derive the slug a business-process name will get server-side, for previews
 * and duplicate checks in the create dialog. Must stay in step with gitops's
 * `slugify_bp_name` (app/services/process_service.py) — the server's answer
 * is authoritative; this one only has to match it for honest previews.
 *
 * Rule: fold diacritics to ASCII, drop what doesn't fold, lowercase, collapse
 * every other run of characters to a single dash. Returns '' when nothing
 * survives (a name with no Latin letters or digits).
 */
export function slugifyBpName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\P{ASCII}/gu, '') // like Python's encode('ascii', 'ignore')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

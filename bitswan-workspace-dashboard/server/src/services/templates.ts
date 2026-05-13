import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Same root the editor uses (`/workspace/examples`). Mounted read-only into
 * the dashboard container by bitswan-automation-server's compose generation.
 */
export const TEMPLATES_ROOT = '/workspace/examples';

export interface TemplateInfo {
  /** Directory name — also the lookup id for the create endpoint. */
  id: string;
  name: string;
  shortDescription: string;
  iconSvg: string;
  /** Where the template lives on disk (so the creator doesn't re-resolve). */
  sourceDir: string;
}

export interface TemplateGroupInfo {
  id: string;
  name: string;
  shortDescription: string;
  iconSvg: string;
  /** Subdirectory names under the group root — each is its own automation. */
  automations: string[];
  sourceDir: string;
}

// Same TOML extraction strategy the editor uses — regex over a few specific
// fields. Avoids pulling a TOML parser into the server for what's effectively
// three string lookups. If template authors ever need richer metadata we'll
// swap this for a real parser.
function readMetadata(filePath: string): {
  name: string;
  shortDescription: string;
  iconSvg: string;
} | null {
  let content: string;
  try {
    content = fsSync.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const nameMatch = content.match(/\bname\s*=\s*"([^"]+)"/);
  if (!nameMatch) return null;
  const shortDescMatch = content.match(
    /\bshort_description\s*=\s*"""([\s\S]*?)"""/,
  );
  const iconMatch = content.match(/\bicon\s*=\s*"""([\s\S]*?)"""/);
  return {
    name: nameMatch[1]!.trim(),
    shortDescription: (shortDescMatch?.[1] ?? '').trim(),
    iconSvg: (iconMatch?.[1] ?? '').trim(),
  };
}

function readTemplate(dirPath: string): TemplateInfo | null {
  const tomlPath = path.join(dirPath, 'template.toml');
  if (!fsSync.existsSync(tomlPath)) return null;
  const meta = readMetadata(tomlPath);
  if (!meta) return null;
  return {
    id: path.basename(dirPath),
    name: meta.name,
    shortDescription: meta.shortDescription,
    iconSvg: meta.iconSvg,
    sourceDir: dirPath,
  };
}

function readGroup(dirPath: string): TemplateGroupInfo | null {
  const tomlPath = path.join(dirPath, 'group.toml');
  if (!fsSync.existsSync(tomlPath)) return null;
  const meta = readMetadata(tomlPath);
  if (!meta) return null;
  // Find automation subdirectories (presence of automation.toml or pipelines.conf).
  const automations: string[] = [];
  try {
    const entries = fsSync.readdirSync(dirPath, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sub = path.join(dirPath, e.name);
      if (
        fsSync.existsSync(path.join(sub, 'automation.toml')) ||
        fsSync.existsSync(path.join(sub, 'pipelines.conf'))
      ) {
        automations.push(e.name);
      }
    }
  } catch {
    // ignore — empty group will be filtered below
  }
  if (automations.length === 0) return null;
  return {
    id: path.basename(dirPath),
    name: meta.name,
    shortDescription: meta.shortDescription,
    iconSvg: meta.iconSvg,
    automations,
    sourceDir: dirPath,
  };
}

function discoverInRoot(rootDir: string): {
  templates: TemplateInfo[];
  groups: TemplateGroupInfo[];
} {
  const templates: TemplateInfo[] = [];
  const groups: TemplateGroupInfo[] = [];
  if (!fsSync.existsSync(rootDir)) return { templates, groups };
  let entries: fsSync.Dirent[];
  try {
    entries = fsSync.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return { templates, groups };
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(rootDir, e.name);
    const t = readTemplate(dir);
    if (t) {
      templates.push(t);
      continue;
    }
    const g = readGroup(dir);
    if (g) groups.push(g);
  }
  return { templates, groups };
}

/**
 * Discover templates + groups, merging the built-in `/workspace/examples`
 * root with a user-supplied `<workspaceRoot>/templates/` directory (same
 * behaviour as the editor: workspace entries override built-ins of the same
 * id).
 */
export function discoverTemplates(workspaceRoot: string): {
  templates: TemplateInfo[];
  groups: TemplateGroupInfo[];
} {
  const builtin = discoverInRoot(TEMPLATES_ROOT);
  const overrides = discoverInRoot(path.join(workspaceRoot, 'templates'));

  const templates = new Map<string, TemplateInfo>();
  const groups = new Map<string, TemplateGroupInfo>();
  for (const t of builtin.templates) templates.set(t.id, t);
  for (const g of builtin.groups) groups.set(g.id, g);
  for (const t of overrides.templates) templates.set(t.id, t);
  for (const g of overrides.groups) groups.set(g.id, g);

  return {
    templates: [...templates.values()].sort((a, b) => a.name.localeCompare(b.name)),
    groups: [...groups.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// --- Creating an automation from a template ----------------------------

const AUTOMATION_NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Editor-compatible name sanitisation: lowercase, non-`[a-z0-9-]` collapsed
 * to `-`, leading/trailing dashes trimmed. Mirrors `sanitizeName` in
 * `bitswan-editor/Extension/src/utils/nameUtils.ts`.
 */
export function sanitizeAutomationName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function copyDirRecursive(src: string, dest: string, skip?: Set<string>) {
  const stat = fsSync.lstatSync(src);
  if (!stat.isDirectory()) {
    throw new Error(`Template source is not a directory: ${src}`);
  }
  fsSync.mkdirSync(dest, { recursive: true });
  const entries = fsSync.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (skip?.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      // Preserve verbatim — templates ship symlinks pointing at in-container
      // paths (e.g. `bitswan_lib` -> `/workspace/bitswan_lib`).
      const target = fsSync.readlinkSync(srcPath);
      fsSync.symlinkSync(target, destPath);
    } else if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fsSync.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Add (or fill in) the `[deployment] id = "<uuid>"` line in `automation.toml`
 * if missing. Mirrors `ensureAutomationId` in the editor — we do it with a
 * targeted string edit instead of a TOML round-trip so authoring conventions
 * (comments, formatting) survive.
 */
function ensureAutomationId(targetDir: string): void {
  const tomlPath = path.join(targetDir, 'automation.toml');
  const newId = randomUUID();
  if (!fsSync.existsSync(tomlPath)) {
    fsSync.writeFileSync(tomlPath, `[deployment]\nid = "${newId}"\n`, 'utf8');
    return;
  }
  const content = fsSync.readFileSync(tomlPath, 'utf8');
  // Already has an id under [deployment]? Leave alone.
  const idRe = /\[deployment\][\s\S]*?(^\s*id\s*=\s*)/m;
  if (idRe.test(content)) return;

  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(newline);
  let inDeployment = false;
  let deploymentSectionIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inDeployment = trimmed.toLowerCase() === '[deployment]';
      if (inDeployment) {
        deploymentSectionIdx = i;
        break;
      }
    }
  }
  if (deploymentSectionIdx >= 0) {
    lines.splice(deploymentSectionIdx + 1, 0, `id = "${newId}"`);
  } else {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push('[deployment]');
    lines.push(`id = "${newId}"`);
  }
  fsSync.writeFileSync(tomlPath, lines.join(newline), 'utf8');
}

export interface CreateAutomationInput {
  /** Template id (subdirectory name under `/workspace/examples` or workspace `templates/`). */
  templateId?: string;
  /** Group id (creates ALL automations bundled in the group). */
  groupId?: string;
  /** Name to use for the new automation directory. Sanitised before use. */
  name?: string;
  /** BP directory name (i.e. the `id` field on the dashboard's `BusinessProcess`). */
  bp: string;
  /** Optional worktree to target — same shape as the rest of the API. */
  worktree?: string;
}

export interface CreateAutomationResult {
  created: { name: string; relativePath: string }[];
}

export async function createAutomationFromTemplate(
  input: CreateAutomationInput,
  workspaceRoot: string,
): Promise<CreateAutomationResult> {
  const { templateId, groupId, name, bp, worktree } = input;
  if (!bp) throw new Error('bp is required');
  if (!templateId && !groupId) {
    throw new Error('templateId or groupId is required');
  }
  if (templateId && groupId) {
    throw new Error('templateId and groupId are mutually exclusive');
  }

  const { templates, groups } = discoverTemplates(workspaceRoot);

  // Resolve the workspace-relative BP directory: either `<bp>` on main, or
  // `worktrees/<wt>/<bp>` in a worktree.
  const bpRelativePath = worktree ? path.join('worktrees', worktree, bp) : bp;
  const bpFullPath = path.join(workspaceRoot, bpRelativePath);
  await fs.mkdir(bpFullPath, { recursive: true });

  const created: { name: string; relativePath: string }[] = [];

  if (templateId) {
    const tpl = templates.find((t) => t.id === templateId);
    if (!tpl) throw new Error(`Unknown template: ${templateId}`);
    const sanitized = sanitizeAutomationName(name ?? '');
    if (!sanitized || !AUTOMATION_NAME_RE.test(sanitized)) {
      throw new Error('Invalid automation name');
    }
    const dest = path.join(bpFullPath, sanitized);
    if (fsSync.existsSync(dest)) {
      throw new Error(
        `A folder named "${sanitized}" already exists in this business process.`,
      );
    }
    // Match editor behaviour — skip `template.toml` so it doesn't end up
    // in the new automation directory.
    copyDirRecursive(tpl.sourceDir, dest, new Set(['template.toml']));
    ensureAutomationId(dest);
    created.push({ name: sanitized, relativePath: path.join(bpRelativePath, sanitized) });
  } else if (groupId) {
    const group = groups.find((g) => g.id === groupId);
    if (!group) throw new Error(`Unknown group: ${groupId}`);
    // Validate up front — fail the whole operation rather than half-creating.
    for (const automation of group.automations) {
      const dest = path.join(bpFullPath, automation);
      if (fsSync.existsSync(dest)) {
        throw new Error(
          `A folder named "${automation}" already exists in this business process.`,
        );
      }
    }
    for (const automation of group.automations) {
      const src = path.join(group.sourceDir, automation);
      const dest = path.join(bpFullPath, automation);
      copyDirRecursive(src, dest);
      ensureAutomationId(dest);
      created.push({
        name: automation,
        relativePath: path.join(bpRelativePath, automation),
      });
    }
  }

  return { created };
}

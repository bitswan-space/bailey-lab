import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  addRequirement,
  annotateHasTest,
  listRequirements,
  readTestingAutomation,
  removeRequirement,
  updateRequirement,
} from './requirements.js';

/**
 * The contract file, now that verdicts have left it. What matters here is that
 * a pass/fail can no longer enter or leave this file, that "proposed" survives
 * as an origin rather than a status, and that hasTest does not credit one
 * requirement with another's test.
 */

let root = '';
const COPY = 'dev1';
const BP = 'shop';

function scope() {
  return { workspaceRoot: root, copy: COPY, bp: BP };
}

async function writeContract(body: string) {
  await fs.writeFile(
    path.join(root, 'copies', COPY, BP, 'testable-requirements.toml'),
    body,
    'utf8',
  );
}

async function readContract(): Promise<string> {
  return fs.readFile(
    path.join(root, 'copies', COPY, BP, 'testable-requirements.toml'),
    'utf8',
  );
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'reqs-'));
  await fs.mkdir(path.join(root, 'copies', COPY, BP), { recursive: true });
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('the contract carries no verdicts', () => {
  it('ignores a status left behind by an older file', async () => {
    await writeContract(
      '[[requirement]]\nid = "REQ-7QX4"\ndescription = "a"\nstatus = "pass"\n',
    );
    const reqs = await listRequirements(scope());
    assert.equal(reqs.length, 1);
    assert.equal((reqs[0] as unknown as { status?: string }).status, undefined);
  });

  it('drops that status the next time the file is written', async () => {
    await writeContract(
      '[[requirement]]\nid = "REQ-7QX4"\ndescription = "a"\nstatus = "pass"\n',
    );
    await addRequirement({ ...scope(), text: 'b' });
    const text = await readContract();
    assert.ok(!text.includes('status'), `status survived a write:\n${text}`);
  });
});

describe('origin', () => {
  it('records a proposal as an origin, with an AI- id', async () => {
    await writeContract('');
    const created = await addRequirement({ ...scope(), text: 'x', proposed: true });
    assert.equal(created.origin, 'proposed');
    assert.ok(created.id.startsWith('AI-'));
  });

  it('accepting clears the origin but keeps the id', async () => {
    await writeContract('');
    const created = await addRequirement({ ...scope(), text: 'x', proposed: true });
    const accepted = await updateRequirement({
      ...scope(),
      id: created.id,
      patch: { accept: true },
    });
    // The id must survive: a test may already be named after it.
    assert.equal(accepted.id, created.id);
    assert.equal(accepted.origin, '');
  });

  it("a human's own requirement has no origin and a REQ- id", async () => {
    await writeContract('');
    const created = await addRequirement({ ...scope(), text: 'x' });
    assert.equal(created.origin, '');
    assert.ok(created.id.startsWith('REQ-'));
  });
});

describe('ids', () => {
  it('are random, so two copies cannot mint the same one', async () => {
    await writeContract('');
    const ids = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      ids.add((await addRequirement({ ...scope(), text: `r${i}` })).id);
    }
    assert.equal(ids.size, 25);
  });
});

describe('per-requirement overrides round-trip', () => {
  it('keeps automation and runner, and omits them when unset', async () => {
    await writeContract(
      '[[requirement]]\nid = "REQ-7QX4"\ndescription = "a"\n' +
        'automation = "backend"\nrunner = "cd /app && go test -json ./..."\n\n' +
        '[[requirement]]\nid = "REQ-8ABC"\ndescription = "b"\n',
    );
    const reqs = await listRequirements(scope());
    assert.equal(reqs[0]!.automation, 'backend');
    assert.ok(reqs[0]!.runner.includes('go test'));
    assert.equal(reqs[1]!.automation, '');

    await removeRequirement({ ...scope(), id: 'REQ-8ABC' });
    const text = await readContract();
    assert.ok(text.includes('automation = "backend"'));
  });
});

describe('hasTest', () => {
  it('does not credit a requirement with a longer id’s test', async () => {
    await writeContract(
      '[[requirement]]\nid = "REQ-100"\n\n[[requirement]]\nid = "REQ-1000"\n',
    );
    await fs.writeFile(
      path.join(root, 'copies', COPY, BP, 'test_app.py'),
      'def test_REQ_1000_only():\n    pass\n',
      'utf8',
    );
    const annotated = await annotateHasTest(scope(), await listRequirements(scope()));
    const byId = new Map(annotated.map((r) => [r.id, r.hasTest]));
    assert.equal(byId.get('REQ-1000'), true);
    assert.equal(byId.get('REQ-100'), false);
  });
});

describe('which container a requirement runs in', () => {
  async function writeProcess(body: string) {
    await fs.writeFile(
      path.join(root, 'copies', COPY, BP, 'process.toml'),
      body,
      'utf8',
    );
  }

  it('falls back to the BP default when the requirement pins nothing', async () => {
    // The common case: in a real BP none of the requirements carry an
    // `automation` key — it comes from process.toml.
    await writeContract('[[requirement]]\nid = "REQ-AAAA"\n');
    await writeProcess('[testing]\nautomation = "backend"\nframework = "go"\n');

    const [row] = await annotateHasTest(scope(), await listRequirements(scope()));
    assert.equal(row!.automation, '', 'the contract field stays as written');
    assert.equal(row!.effectiveAutomation, 'backend');
  });

  it('prefers the requirement’s own pin over the default', async () => {
    await writeContract(
      '[[requirement]]\nid = "REQ-AAAA"\nautomation = "new-worker"\n',
    );
    await writeProcess('[testing]\nautomation = "backend"\n');

    const [row] = await annotateHasTest(scope(), await listRequirements(scope()));
    assert.equal(row!.effectiveAutomation, 'new-worker');
  });

  it('resolves to nothing when neither says', async () => {
    await writeContract('[[requirement]]\nid = "REQ-AAAA"\n');
    await writeProcess('process-id = "x"\n');

    const [row] = await annotateHasTest(scope(), await listRequirements(scope()));
    assert.equal(row!.effectiveAutomation, '');
  });

  it('treats a missing or unparseable process.toml as no default', async () => {
    // Not this surface's problem to report — the test runner says so loudly
    // enough when it tries to use it.
    await fs.rm(path.join(root, 'copies', COPY, BP, 'process.toml'), {
      force: true,
    });
    assert.equal(await readTestingAutomation(scope()), '');

    await writeProcess('[testing]\nautomation = ');
    assert.equal(await readTestingAutomation(scope()), '');
  });
});

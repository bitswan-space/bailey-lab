import { recordTouch } from './recorder.js';

const STUB = Symbol('vscodeStub');

export function isStub(value: unknown): boolean {
  return typeof value === 'function' && (value as { [STUB]?: boolean })[STUB] === true;
}

export function makeStub(path: string): unknown {
  const target = function stubTarget() {} as unknown as Record<string | symbol, unknown>;
  (target as { [STUB]?: boolean })[STUB] = true;

  return new Proxy(target, {
    get(_t, prop) {
      if (prop === STUB) return true;
      if (typeof prop === 'symbol') {
        if (prop === Symbol.toPrimitive) return () => `[vscode stub ${path}]`;
        return undefined;
      }
      if (prop === 'then') return undefined;
      if (prop === 'toJSON') return () => `[vscode stub ${path}]`;
      if (prop === 'inspect' || prop === 'constructor') return undefined;
      recordTouch(`${path}.${prop}`, 'get', false);
      return makeStub(`${path}.${prop}`);
    },
    apply(_t, _thisArg, args) {
      recordTouch(path, 'call', false);
      if (args.some((a) => typeof a === 'function')) return makeStub(`${path}()`);
      return makeStub(`${path}()`);
    },
    construct(_t, _args) {
      recordTouch(path, 'construct', false);
      return makeStub(`new ${path}`) as object;
    },
  });
}

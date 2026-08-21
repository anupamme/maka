/**
 * The ＋ menu's mode rows and the divider above them.
 *
 * Each row gets the control its field is. Plan is a Session field of its own
 * and an independent switch. Swarm and Graph are the two values of one other
 * field, so they are one group and picking one is picking away from the other
 * — announced as a set rather than left for a screen reader to miss. Neither
 * is chosen at rest, and no row stands for that; every prop that feeds them is
 * optional, so a host can wire the modes alone, and then there is nothing
 * above the divider to divide.
 *
 * Astryx 0.4.3 mounts DropdownMenu layers from a client ref, so the rows are
 * not in server markup. The assertions still name the same document, after
 * that mount.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { Composer } from '../composer.js';
import { LocaleProvider } from '../locale-context.js';

const originalGlobals = {
  document: globalThis.document,
  matchMedia: globalThis.matchMedia,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  window: globalThis.window,
};
const originalActEnvironment = (globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT;

const mountedRoots: ReturnType<typeof createRoot>[] = [];

afterEach(async () => {
  for (const root of mountedRoots.splice(0)) await act(() => root.unmount());
  Object.assign(globalThis, {
    ...originalGlobals,
    IS_REACT_ACT_ENVIRONMENT: originalActEnvironment,
  });
});

function computedStyle(): CSSStyleDeclaration {
  return {
    direction: 'ltr',
    writingMode: 'horizontal-tb',
    getPropertyValue: () => '',
  } as unknown as CSSStyleDeclaration;
}

function domRoot() {
  const { document, window } = parseHTML('<div id="root"></div>');
  window.getComputedStyle = () => computedStyle();
  Object.assign(globalThis, {
    document,
    window,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.querySelector('#root');
  assert.ok(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  return { container, root };
}

async function render(props: Parameters<typeof Composer>[0]): Promise<string> {
  const { container, root } = domRoot();
  await act(() => {
    root.render(
      <LocaleProvider locale="en">
        <Composer {...props} />
      </LocaleProvider>,
    );
  });
  return container.ownerDocument.documentElement.innerHTML;
}

async function plusMenu(props: Parameters<typeof Composer>[0]): Promise<string> {
  const markup = await render(props);
  // The marker must still be in the composer chrome. Menu rows may portal
  // out of that span, so later assertions read the whole document.
  assert.ok(markup.includes('maka-composer-plus-menu'), 'the composer rendered no ＋ menu');
  return markup;
}

function count(markup: string, needle: string): number {
  return markup.split(needle).length - 1;
}

/** Opening tags carrying every one of these attributes, in any order. */
function tagsWith(markup: string, ...attributes: readonly string[]): readonly string[] {
  return (markup.match(/<[a-z]+[^>]*>/g) ?? []).filter(
    (tag) => attributes.every((attribute) => tag.includes(attribute)),
  );
}

const base = {
  onSend: () => undefined,
  onStop: () => undefined,
  planModeActive: false,
  onPlanModeChange: () => undefined,
  orchestrationMode: 'default' as const,
  onOrchestrationModeChange: () => undefined,
};

test('the mode controls alone open the menu on a row, not on a rule', async () => {
  assert.equal((await plusMenu(base)).includes('astryx-dropdown-menu-divider'), false);
});

test('an action row above the mode controls keeps the divider', async () => {
  const withAction = await plusMenu({ ...base, onPickAttachments: () => undefined });
  assert.equal(withAction.includes('astryx-dropdown-menu-divider'), true);
});

test('each mode row is the control its field is, and none of them is on', async () => {
  const menu = await plusMenu(base);
  assert.equal(count(menu, 'role="menuitemcheckbox"'), 1, 'Plan alone is a switch');
  // Two rows, not three: the field's third value is this group holding none.
  assert.equal(count(menu, 'role="menuitemradio"'), 2, 'Swarm and Graph, no neutral row');
  assert.equal(
    tagsWith(menu, 'role="group"', 'aria-label="Orchestration mode"').length,
    1,
    'the exclusive pair is announced as one named set',
  );
  assert.equal(count(menu, 'aria-checked="true"'), 0, 'nothing on is nothing checked');
});

test('Plan and an orchestration mode are both on at once', async () => {
  const markup = await render({ ...base, planModeActive: true, orchestrationMode: 'swarm' });
  assert.ok(markup.includes('maka-composer-plus-menu'), 'the composer rendered no ＋ menu');
  assert.equal(
    tagsWith(markup, 'role="menuitemcheckbox"', 'aria-checked="true"').length,
    1,
    'Plan is not checked',
  );
  assert.equal(
    tagsWith(markup, 'role="menuitemradio"', 'aria-checked="true"').length,
    1,
    'Swarm is not checked, or Graph is checked with it',
  );
  // Each one keeps its own readout and its own way out, so neither hides the
  // other: a Plan excursion does not clear the orchestration default.
  assert.equal(count(markup, 'maka-composer-mode-button'), 2);
  assert.ok(markup.includes('data-mode="plan"'));
  assert.ok(markup.includes('data-mode="swarm"'));
});

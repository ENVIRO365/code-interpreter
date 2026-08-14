import { describe, expect, test } from 'bun:test';
import { parseKeyCombo, scrollDelta } from './browse-driver';

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

describe('parseKeyCombo', () => {
  test('maps named keys to their virtual key codes', () => {
    expect(parseKeyCombo('Return')).toMatchObject({ key: 'Enter', code: 'Enter', vk: 13 });
    expect(parseKeyCombo('Tab')).toMatchObject({ key: 'Tab', vk: 9 });
    expect(parseKeyCombo('PageDown')).toMatchObject({ key: 'PageDown', vk: 34 });
  });

  test('is case insensitive on names', () => {
    expect(parseKeyCombo('ESCAPE').key).toBe('Escape');
    expect(parseKeyCombo('escape').key).toBe('Escape');
  });

  test('accumulates modifier bits', () => {
    expect(parseKeyCombo('ctrl+a').modifiers).toBe(2);
    expect(parseKeyCombo('shift+Tab').modifiers).toBe(8);
    expect(parseKeyCombo('ctrl+shift+a').modifiers).toBe(10);
  });

  test('sends text for a bare printable key but not for a shortcut', () => {
    /* With `text` present Chromium inserts the character; a shortcut must
     * reach the page as a command instead, so ctrl+a selects rather than
     * typing an "a". */
    expect(parseKeyCombo('a').text).toBe('a');
    expect(parseKeyCombo('ctrl+a').text).toBeUndefined();
    expect(parseKeyCombo('Return').text).toBe('\r');
    expect(parseKeyCombo('ctrl+Return').text).toBeUndefined();
  });

  test('rejects empty, unknown keys, and unknown modifiers', () => {
    expect(messageOf(() => parseKeyCombo('   '))).toContain('must not be empty');
    expect(messageOf(() => parseKeyCombo('NotAKey'))).toContain('unknown key');
    expect(messageOf(() => parseKeyCombo('hyper+a'))).toContain('unknown key modifier');
  });
});

describe('scrollDelta', () => {
  test('translates direction and amount into wheel pixels', () => {
    expect(scrollDelta('down', 3)).toEqual({ deltaX: 0, deltaY: 300 });
    expect(scrollDelta('up', 2)).toEqual({ deltaX: 0, deltaY: -200 });
    expect(scrollDelta('right', 1)).toEqual({ deltaX: 100, deltaY: 0 });
    expect(scrollDelta('left', 1)).toEqual({ deltaX: -100, deltaY: 0 });
  });

  test('defaults to scrolling down when no direction is given', () => {
    expect(scrollDelta(undefined, 3)).toEqual({ deltaX: 0, deltaY: 300 });
  });
});

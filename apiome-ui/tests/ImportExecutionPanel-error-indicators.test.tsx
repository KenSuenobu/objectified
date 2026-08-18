/**
 * Unit tests for Import Execution Panel error indicators (#731) and skipped items (#732)
 *
 * #731: failures read as failures (Failures section, Live Progress, Import Log)
 * #732: intentionally skipped items (SKIP_PROPERTY, SKIP_CHILDREN) read as quiet, not as warnings
 *
 * Helpers: getErrorEvents, formatEventContext, importEventLevel, shouldShowFailuresSection,
 * isSkippedEvent.
 *
 * HIVE-6.4 (#5315) replaced the two class-string helpers with {@link importEventLevel}: the
 * severity is now carried as `data-level` and painted by `globals.css` §IMPORT WIZARD, so what
 * belongs here is the *mapping* and what belongs in `import-wizard-css.test.ts` is the colour.
 */

import { describe, test, expect } from '@jest/globals';
import {
  getErrorEvents,
  formatEventContext,
  importEventLevel,
  isSkippedEvent,
  shouldShowFailuresSection,
  type ImportEventLike,
} from '../lib/import-execution-error-indicators';

describe('Import Execution Panel - Error Indicators (#731)', () => {
  describe('getErrorEvents', () => {
    test('returns only events with level "error"', () => {
      const events: ImportEventLike[] = [
        { id: '1', ts: 1, level: 'info', code: 'START', message: 'Started' },
        { id: '2', ts: 2, level: 'error', code: 'ERR', message: 'Failed' },
        { id: '3', ts: 3, level: 'warn', code: 'WARN', message: 'Warning' },
        { id: '4', ts: 4, level: 'error', code: 'ERR2', message: 'Failed again' },
      ];
      const result = getErrorEvents(events);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('2');
      expect(result[1].id).toBe('4');
    });

    test('returns empty array when no error events', () => {
      const events: ImportEventLike[] = [
        { id: '1', ts: 1, level: 'info', code: 'A', message: 'A' },
        { id: '2', ts: 2, level: 'warn', code: 'B', message: 'B' },
      ];
      expect(getErrorEvents(events)).toEqual([]);
    });

    test('returns empty array for empty input', () => {
      expect(getErrorEvents([])).toEqual([]);
    });
  });

  describe('formatEventContext', () => {
    test('returns string context as-is', () => {
      expect(formatEventContext('Unexpected token at line 5')).toBe('Unexpected token at line 5');
    });

    test('formats object context as pretty-printed JSON', () => {
      const ctx = { schemaName: 'Foo', reason: 'Duplicate' };
      const out = formatEventContext(ctx);
      expect(out).toContain('"schemaName": "Foo"');
      expect(out).toContain('"reason": "Duplicate"');
    });

    test('returns empty string for null/undefined', () => {
      expect(formatEventContext(null)).toBe('');
      expect(formatEventContext(undefined)).toBe('');
    });
  });

  describe('importEventLevel', () => {
    test('maps a bare level straight through', () => {
      expect(importEventLevel('error')).toBe('error');
      expect(importEventLevel('warn')).toBe('warn');
      expect(importEventLevel('info')).toBe('info');
    });

    test('an ordinary event keeps its own level', () => {
      const ev: ImportEventLike = { id: '1', ts: 0, level: 'error', code: 'CLASS_FAILED', message: 'Fail' };
      expect(importEventLevel(ev)).toBe('error');
    });
  });

  describe('isSkippedEvent / skipped items in gray (#732)', () => {
    test('isSkippedEvent returns true for SKIP_PROPERTY and SKIP_CHILDREN', () => {
      expect(isSkippedEvent({ id: '1', ts: 0, level: 'warn', code: 'SKIP_PROPERTY', message: 'Skip' })).toBe(true);
      expect(isSkippedEvent({ id: '2', ts: 0, level: 'warn', code: 'SKIP_CHILDREN', message: 'Skip' })).toBe(true);
    });

    test('isSkippedEvent returns false for other codes', () => {
      expect(isSkippedEvent({ id: '1', ts: 0, level: 'warn', code: 'PROPERTY_CREATE_WARN', message: 'W' })).toBe(false);
      expect(isSkippedEvent({ id: '2', ts: 0, level: 'info', code: 'CLASS_CREATED', message: 'Ok' })).toBe(false);
    });

    test('isSkippedEvent returns false for similar-looking codes (no partial match)', () => {
      expect(isSkippedEvent({ id: '1', ts: 0, level: 'info', code: 'SKIP', message: 'x' })).toBe(false);
      expect(isSkippedEvent({ id: '2', ts: 0, level: 'info', code: 'SKIP_PROPERTIES', message: 'x' })).toBe(false);
      expect(isSkippedEvent({ id: '3', ts: 0, level: 'info', code: '', message: 'x' })).toBe(false);
    });

    test('skipped events are not treated as errors (excluded from getErrorEvents)', () => {
      const events: ImportEventLike[] = [
        { id: '1', ts: 1, level: 'warn', code: 'SKIP_PROPERTY', message: 'Skipping property "x"' },
        { id: '2', ts: 2, level: 'warn', code: 'SKIP_CHILDREN', message: 'Also skipping 3 child properties' },
      ];
      expect(getErrorEvents(events)).toHaveLength(0);
    });

    test('a skipped event is drawn at its own level, not as a warning', () => {
      const ev: ImportEventLike = { id: '1', ts: 0, level: 'warn', code: 'SKIP_PROPERTY', message: 'Skipping property' };
      expect(importEventLevel(ev)).toBe('skipped');
    });

    test('both skip codes read as skipped', () => {
      const ev: ImportEventLike = { id: '1', ts: 0, level: 'warn', code: 'SKIP_CHILDREN', message: 'Also skipping' };
      expect(importEventLevel(ev)).toBe('skipped');
    });

    test('a bare level string can never be skipped — only a code makes a skip deliberate', () => {
      expect(importEventLevel('warn')).toBe('warn');
      expect(importEventLevel('info')).toBe('info');
    });

    test('mixed events: skipped, error and info each keep their own severity', () => {
      const skipped: ImportEventLike = { id: 's', ts: 1, level: 'warn', code: 'SKIP_PROPERTY', message: 'Skip' };
      const error: ImportEventLike = { id: 'e', ts: 2, level: 'error', code: 'CLASS_FAILED', message: 'Fail' };
      const info: ImportEventLike = { id: 'i', ts: 3, level: 'info', code: 'CLASS_CREATED', message: 'Ok' };

      expect(importEventLevel(skipped)).toBe('skipped');
      expect(importEventLevel(error)).toBe('error');
      expect(importEventLevel(info)).toBe('info');
    });
  });

  describe('shouldShowFailuresSection', () => {
    test('returns true when there is at least one error event', () => {
      expect(
        shouldShowFailuresSection([
          { id: '1', ts: 1, level: 'info', code: 'A', message: 'A' },
          { id: '2', ts: 2, level: 'error', code: 'ERR', message: 'Fail' },
        ])
      ).toBe(true);
    });

    test('returns false when there are no error events', () => {
      expect(
        shouldShowFailuresSection([
          { id: '1', ts: 1, level: 'info', code: 'A', message: 'A' },
          { id: '2', ts: 2, level: 'warn', code: 'W', message: 'W' },
        ])
      ).toBe(false);
    });

    test('returns false for empty events', () => {
      expect(shouldShowFailuresSection([])).toBe(false);
    });
  });

  describe('Failures section contract (red + details)', () => {
    test('error events include code, message, and optional context for details', () => {
      const errorEvent: ImportEventLike = {
        id: 'ev-1',
        ts: 12345,
        level: 'error',
        code: 'IMPORT_ERROR',
        message: 'Failed to create class Foo',
        context: { schemaName: 'Foo', reason: 'Duplicate' },
      };
      const filtered = getErrorEvents([errorEvent]);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].code).toBe('IMPORT_ERROR');
      expect(filtered[0].message).toBe('Failed to create class Foo');
      expect(formatEventContext(filtered[0].context)).toContain('Foo');
      expect(formatEventContext(filtered[0].context)).toContain('Duplicate');
    });
  });
});

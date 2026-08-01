/**
 * Shared spec-format pill palette (REPO-6.4, #2797).
 *
 * The per-repository Files browser and the cross-repo catalog render the same spec type in the
 * same pill — one from REST's `display_kind` string, the other from its normalized `format`
 * family key. These tests pin the two entry points to one palette, so a spec cannot read as
 * green on one page and grey on the other.
 */

import { describe, test, expect } from '@jest/globals';
import {
  repositoryDisplayKindPillClass,
  repositoryFormatPillClass,
} from '@/app/components/ade/dashboard/repositories/repositorySpecFormat';

describe('format families', () => {
  test.each([
    ['openapi', 'emerald'],
    ['arazzo', 'indigo'],
    ['asyncapi', 'cyan'],
    ['json_schema', 'purple'],
    ['graphql', 'pink'],
    ['protobuf', 'amber'],
    ['postman', 'amber'],
    ['sql_ddl', 'amber'],
    ['prisma', 'teal'],
    ['avro', 'sky'],
    ['dbml', 'teal'],
  ])('%s uses the %s pill', (format, tone) => {
    expect(repositoryFormatPillClass(format)).toContain(tone);
  });

  test('every pill styles both colour schemes', () => {
    for (const format of ['openapi', 'arazzo', 'asyncapi', 'json_schema', 'other']) {
      expect(repositoryFormatPillClass(format)).toMatch(/dark:/);
    }
  });

  test('a family key is matched case- and whitespace-insensitively', () => {
    expect(repositoryFormatPillClass('  OpenAPI ')).toBe(repositoryFormatPillClass('openapi'));
  });

  test.each(['other', 'unclassified', 'raml', ''])(
    '%s falls back to the neutral pill rather than throwing',
    (format) => {
      expect(repositoryFormatPillClass(format)).toContain('gray');
    }
  );
});

describe('display kinds resolve to the same palette', () => {
  test.each([
    ['OpenAPI', 'openapi'],
    ['Arazzo', 'arazzo'],
    ['AsyncAPI', 'asyncapi'],
    ['JSON Schema', 'json_schema'],
    ['GraphQL', 'graphql'],
    ['Protobuf', 'protobuf'],
    ['Postman', 'postman'],
    ['SQL DDL', 'sql_ddl'],
  ])('%s matches the %s family', (displayKind, format) => {
    expect(repositoryDisplayKindPillClass(displayKind)).toBe(repositoryFormatPillClass(format));
  });

  test('an unclassified JSON blob is not painted as JSON Schema', () => {
    expect(repositoryDisplayKindPillClass('JSON (unclassified)')).toContain('gray');
  });

  test.each(['Uncategorised', 'YAML (unclassified)', 'Raml 1 0', ''])(
    '%s falls back to the neutral pill',
    (displayKind) => {
      expect(repositoryDisplayKindPillClass(displayKind)).toContain('gray');
    }
  );
});

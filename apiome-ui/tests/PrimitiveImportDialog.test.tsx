/**
 * Tests for PrimitiveImportDialog file parsing and import functionality
 *
 * These tests focus on the core parsing logic used by the PrimitiveImportDialog
 * to handle JSON and YAML schema files.
 */

import yaml from 'yaml';

import { extractPrimitiveNameFromSchema } from '../src/app/ade/dashboard/primitives/primitiveImportModel';

// Test the parseSchemaContent logic
const parseSchemaContent = (content: string): Record<string, unknown> | null => {
  // First try to parse as JSON
  try {
    return JSON.parse(content);
  } catch {
    // If JSON parsing fails, try YAML
    try {
      const parsed = yaml.parse(content);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }
};

// Extract definitions from a parsed schema
const extractDefinitions = (schema: Record<string, unknown>): Record<string, unknown> => {
  return {
    ...((schema.$defs as Record<string, unknown>) || {}),
    ...((schema.definitions as Record<string, unknown>) || {})
  };
};

// Check if a schema is a standalone primitive schema
const isStandalonePrimitiveSchema = (schema: Record<string, unknown>): boolean => {
  // If it has $defs or definitions, it's a container schema
  const hasDefs = schema.$defs || schema.definitions;
  if (hasDefs) {
    return false;
  }

  // Check for various JSON Schema type indicators
  const hasType = 'type' in schema;
  const hasAnyOf = 'anyOf' in schema;
  const hasOneOf = 'oneOf' in schema;
  const hasAllOf = 'allOf' in schema;
  const hasEnum = 'enum' in schema;
  const hasConst = 'const' in schema;

  return hasType || hasAnyOf || hasOneOf || hasAllOf || hasEnum || hasConst;
};

// Determine the category for a schema (for primitives)
const determineCategoryFromSchema = (schema: Record<string, unknown>): string => {
  // If type is explicitly set, use it
  if (schema.type) {
    const schemaType = schema.type;
    if (typeof schemaType === 'string') {
      return schemaType;
    }
    if (Array.isArray(schemaType) && schemaType.length > 0) {
      return schemaType[0];
    }
  }

  // For anyOf/oneOf with const values, it's typically a string enum
  if (schema.anyOf || schema.oneOf) {
    const options = (schema.anyOf || schema.oneOf) as Record<string, unknown>[];
    if (options.length > 0 && 'const' in options[0]) {
      const firstConst = options[0].const;
      return typeof firstConst === 'string' ? 'string' : typeof firstConst;
    }
  }

  // For enum, check the type of the first value
  if (schema.enum && Array.isArray(schema.enum) && schema.enum.length > 0) {
    return typeof schema.enum[0];
  }

  // For const, check its type
  if ('const' in schema) {
    return typeof schema.const;
  }

  // Default to object
  return 'object';
};

// The real implementation, not a copy: this file previously duplicated it, so the `-` -> `_`
// bug it contained could never be caught here. The other helpers above are still local copies.
describe('PrimitiveImportDialog Parsing Logic', () => {
  describe('parseSchemaContent', () => {
    it('should parse valid JSON content', () => {
      const jsonContent = JSON.stringify({
        $defs: {
          Email: { type: 'string', format: 'email' }
        }
      });

      const result = parseSchemaContent(jsonContent);

      expect(result).not.toBeNull();
      expect(result?.$defs).toBeDefined();
      expect((result?.$defs as any).Email.type).toBe('string');
    });

    it('should parse valid YAML content', () => {
      const yamlContent = `
$defs:
  Email:
    type: string
    format: email
    description: Email address
`;

      const result = parseSchemaContent(yamlContent);

      expect(result).not.toBeNull();
      expect(result?.$defs).toBeDefined();
      expect((result?.$defs as any).Email.type).toBe('string');
      expect((result?.$defs as any).Email.format).toBe('email');
    });

    it('should return null for invalid content', () => {
      const invalidContent = 'this is not json or yaml { broken';

      const result = parseSchemaContent(invalidContent);

      expect(result).toBeNull();
    });

    it('should prefer JSON parsing over YAML', () => {
      // Valid JSON that would also be valid YAML
      const content = '{"key": "value"}';

      const result = parseSchemaContent(content);

      expect(result).not.toBeNull();
      expect(result?.key).toBe('value');
    });

    it('should handle YAML with special characters', () => {
      const yamlContent = `
$defs:
  PhoneNumber:
    type: string
    pattern: "^\\\\+[1-9]\\\\d{1,14}$"
    description: "E.164 phone number format"
`;

      const result = parseSchemaContent(yamlContent);

      expect(result).not.toBeNull();
      expect((result?.$defs as any).PhoneNumber.type).toBe('string');
    });
  });

  describe('extractDefinitions', () => {
    it('should extract $defs from schema', () => {
      const schema = {
        $defs: {
          Email: { type: 'string', format: 'email' },
          Phone: { type: 'string', pattern: '^\\+' }
        }
      };

      const defs = extractDefinitions(schema);

      expect(Object.keys(defs)).toHaveLength(2);
      expect(defs.Email).toBeDefined();
      expect(defs.Phone).toBeDefined();
    });

    it('should extract definitions from older schema format', () => {
      const schema = {
        definitions: {
          Email: { type: 'string', format: 'email' }
        }
      };

      const defs = extractDefinitions(schema);

      expect(Object.keys(defs)).toHaveLength(1);
      expect(defs.Email).toBeDefined();
    });

    it('should merge $defs and definitions', () => {
      const schema = {
        $defs: {
          Email: { type: 'string', format: 'email' }
        },
        definitions: {
          Phone: { type: 'string', pattern: '^\\+' }
        }
      };

      const defs = extractDefinitions(schema);

      expect(Object.keys(defs)).toHaveLength(2);
      expect(defs.Email).toBeDefined();
      expect(defs.Phone).toBeDefined();
    });

    it('should return empty object when no definitions found', () => {
      const schema = {
        type: 'object',
        properties: {}
      };

      const defs = extractDefinitions(schema);

      expect(Object.keys(defs)).toHaveLength(0);
    });

    it('should prefer $defs over definitions for same name', () => {
      const schema = {
        $defs: {
          Email: { type: 'string', format: 'email', source: 'defs' }
        },
        definitions: {
          Email: { type: 'string', format: 'email', source: 'definitions' }
        }
      };

      const defs = extractDefinitions(schema);

      // definitions comes second so it overwrites
      expect((defs.Email as any).source).toBe('definitions');
    });
  });

  describe('File Extension Validation', () => {
    const isValidFileExtension = (fileName: string): boolean => {
      const lowerName = fileName.toLowerCase();
      return lowerName.endsWith('.json') ||
             lowerName.endsWith('.yaml') ||
             lowerName.endsWith('.yml');
    };

    it('should accept .json files', () => {
      expect(isValidFileExtension('schema.json')).toBe(true);
      expect(isValidFileExtension('SCHEMA.JSON')).toBe(true);
      expect(isValidFileExtension('my-schema.json')).toBe(true);
    });

    it('should accept .yaml files', () => {
      expect(isValidFileExtension('schema.yaml')).toBe(true);
      expect(isValidFileExtension('SCHEMA.YAML')).toBe(true);
    });

    it('should accept .yml files', () => {
      expect(isValidFileExtension('schema.yml')).toBe(true);
      expect(isValidFileExtension('SCHEMA.YML')).toBe(true);
    });

    it('should reject invalid extensions', () => {
      expect(isValidFileExtension('schema.txt')).toBe(false);
      expect(isValidFileExtension('schema.xml')).toBe(false);
      expect(isValidFileExtension('schema.js')).toBe(false);
      expect(isValidFileExtension('schema')).toBe(false);
    });
  });

  describe('Complete Import Flow', () => {
    it('should parse JSON file and extract definitions', () => {
      const fileContent = JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $defs: {
          EmailAddress: {
            type: 'string',
            format: 'email',
            description: 'A valid email address'
          },
          Percentage: {
            type: 'number',
            minimum: 0,
            maximum: 100,
            description: 'A percentage value'
          }
        }
      });

      const parsed = parseSchemaContent(fileContent);
      expect(parsed).not.toBeNull();

      const defs = extractDefinitions(parsed!);
      expect(Object.keys(defs)).toHaveLength(2);
      expect(defs.EmailAddress).toBeDefined();
      expect(defs.Percentage).toBeDefined();
    });

    it('should parse YAML file and extract definitions', () => {
      const yamlContent = `
$schema: "https://json-schema.org/draft/2020-12/schema"
$defs:
  EmailAddress:
    type: string
    format: email
    description: A valid email address
  Percentage:
    type: number
    minimum: 0
    maximum: 100
    description: A percentage value
`;

      const parsed = parseSchemaContent(yamlContent);
      expect(parsed).not.toBeNull();

      const defs = extractDefinitions(parsed!);
      expect(Object.keys(defs)).toHaveLength(2);
      expect(defs.EmailAddress).toBeDefined();
      expect(defs.Percentage).toBeDefined();
    });

    it('should handle complex nested schemas', () => {
      const jsonContent = JSON.stringify({
        $defs: {
          Address: {
            type: 'object',
            properties: {
              street: { type: 'string' },
              city: { type: 'string' },
              zip: { $ref: '#/$defs/ZipCode' }
            },
            required: ['street', 'city']
          },
          ZipCode: {
            type: 'string',
            pattern: '^\\d{5}(-\\d{4})?$'
          }
        }
      });

      const parsed = parseSchemaContent(jsonContent);
      expect(parsed).not.toBeNull();

      const defs = extractDefinitions(parsed!);
      expect(Object.keys(defs)).toHaveLength(2);

      const addressDef = defs.Address as any;
      expect(addressDef.type).toBe('object');
      expect(addressDef.properties.street).toBeDefined();
      expect(addressDef.required).toContain('street');
    });
  });

  describe('Standalone Schema Support', () => {
    it('should detect standalone primitive schema', () => {
      const standaloneSchema = {
        type: 'number',
        minimum: 0,
        maximum: 100
      };

      expect(isStandalonePrimitiveSchema(standaloneSchema)).toBe(true);
    });

    it('should not detect schema with $defs as standalone', () => {
      const schemaWithDefs = {
        $defs: {
          Email: { type: 'string' }
        }
      };

      expect(isStandalonePrimitiveSchema(schemaWithDefs)).toBe(false);
    });

    it('should not detect schema without type as standalone', () => {
      const schemaWithoutType = {
        properties: { name: { type: 'string' } }
      };

      expect(isStandalonePrimitiveSchema(schemaWithoutType)).toBe(false);
    });

    it('should extract name from $id (last path segment)', () => {
      const schema = {
        $id: 'https://schemas.sourcemeta.com/sourcemeta/std/v0/iso/units/2022/percentage',
        type: 'number'
      };

      const name = extractPrimitiveNameFromSchema(schema);
      expect(name).toBe('percentage');
    });

    it('preserves hyphens in an $id, which are url-safe', () => {
      const schema = {
        $id: 'https://example.com/my-custom-type',
        type: 'string'
      };

      const name = extractPrimitiveNameFromSchema(schema);
      expect(name).toBe('my-custom-type');
    });

    it('should extract name from title if no $id', () => {
      const schema = {
        title: 'ISO 80000-1:2022 Percentage',
        type: 'number'
      };

      const name = extractPrimitiveNameFromSchema(schema);
      // The regex removes non-alphanumeric characters, so "80000-1:2022" becomes "8000012022"
      expect(name).toBe('iso-80000-1-2022-percentage');
    });

    it('should extract name from filename as fallback', () => {
      const schema = {
        type: 'string'
      };

      const name = extractPrimitiveNameFromSchema(schema, 'my-custom-schema.json');
      expect(name).toBe('my-custom-schema');
    });

    it('should return default name if no other source available', () => {
      const schema = {
        type: 'object'
      };

      const name = extractPrimitiveNameFromSchema(schema);
      expect(name).toBe('imported-primitive');
    });

    it('should handle the ISO percentage schema example', () => {
      const isoPercentageSchema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://schemas.sourcemeta.com/sourcemeta/std/v0/iso/units/2022/percentage",
        "title": "ISO 80000-1:2022 Percentage",
        "description": "A numeric percentage value between 0 and 100",
        "examples": [0, 50, 100],
        "x-license": "https://github.com/sourcemeta/std/blob/main/LICENSE",
        "x-links": ["https://www.iso.org/standard/76921.html"],
        "type": "number",
        "maximum": 100,
        "minimum": 0
      };

      // Should be detected as standalone
      expect(isStandalonePrimitiveSchema(isoPercentageSchema)).toBe(true);

      // Should extract name from $id
      const name = extractPrimitiveNameFromSchema(isoPercentageSchema);
      expect(name).toBe('percentage');

      // The full schema should be preserved including metadata
      expect(isoPercentageSchema['x-license']).toBeDefined();
      expect(isoPercentageSchema['x-links']).toBeDefined();
      expect(isoPercentageSchema.description).toBe('A numeric percentage value between 0 and 100');
      expect(isoPercentageSchema.title).toBe('ISO 80000-1:2022 Percentage');
    });

    it('should handle standalone schema in complete import flow', () => {
      const standaloneContent = JSON.stringify({
        "$id": "https://example.com/email-address",
        "title": "Email Address",
        "description": "A valid email address format",
        "type": "string",
        "format": "email"
      });

      const parsed = parseSchemaContent(standaloneContent);
      expect(parsed).not.toBeNull();
      expect(isStandalonePrimitiveSchema(parsed!)).toBe(true);

      const primitiveName = extractPrimitiveNameFromSchema(parsed!);
      expect(primitiveName).toBe('email-address');

      // Simulating what the dialog does - wrap in $defs for API
      const defsForApi = {
        [primitiveName]: parsed
      };

      expect(defsForApi['email-address']).toBeDefined();
      expect((defsForApi['email-address'] as any).type).toBe('string');
      expect((defsForApi['email-address'] as any).format).toBe('email');
    });

    it('should detect schema with anyOf as standalone', () => {
      const schemaWithAnyOf = {
        anyOf: [
          { const: 'afa', title: 'Afro-Asiatic languages' },
          { const: 'alg', title: 'Algonquian languages' }
        ]
      };

      expect(isStandalonePrimitiveSchema(schemaWithAnyOf)).toBe(true);
    });

    it('should detect schema with oneOf as standalone', () => {
      const schemaWithOneOf = {
        oneOf: [
          { const: 'yes' },
          { const: 'no' }
        ]
      };

      expect(isStandalonePrimitiveSchema(schemaWithOneOf)).toBe(true);
    });

    it('should detect schema with enum as standalone', () => {
      const schemaWithEnum = {
        enum: ['red', 'green', 'blue']
      };

      expect(isStandalonePrimitiveSchema(schemaWithEnum)).toBe(true);
    });

    it('should detect schema with const as standalone', () => {
      const schemaWithConst = {
        const: 'fixed-value'
      };

      expect(isStandalonePrimitiveSchema(schemaWithConst)).toBe(true);
    });

    it('should determine category as string for anyOf with string consts', () => {
      const schemaWithAnyOf = {
        anyOf: [
          { const: 'afa', title: 'Afro-Asiatic languages' },
          { const: 'alg', title: 'Algonquian languages' }
        ]
      };

      const category = determineCategoryFromSchema(schemaWithAnyOf);
      expect(category).toBe('string');
    });

    it('should determine category as number for anyOf with number consts', () => {
      const schemaWithAnyOf = {
        anyOf: [
          { const: 1, title: 'One' },
          { const: 2, title: 'Two' }
        ]
      };

      const category = determineCategoryFromSchema(schemaWithAnyOf);
      expect(category).toBe('number');
    });

    it('should determine category from enum values', () => {
      const schemaWithStringEnum = {
        enum: ['red', 'green', 'blue']
      };
      expect(determineCategoryFromSchema(schemaWithStringEnum)).toBe('string');

      const schemaWithNumberEnum = {
        enum: [1, 2, 3]
      };
      expect(determineCategoryFromSchema(schemaWithNumberEnum)).toBe('number');
    });

    it('should handle the ISO 639-5 Language Family schema example', () => {
      const isoLanguageFamilySchema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://schemas.sourcemeta.com/sourcemeta/std/v0/iso/language/2023/set-5",
        "title": "ISO 639-5:2023 Language Family Code",
        "description": "A three-letter code for language families and groups from ISO 639-5",
        "$comment": "Set 5 codes language families and groups, not individual languages",
        "examples": ["afa", "alg", "apa", "art"],
        "x-license": "https://github.com/sourcemeta/std/blob/main/LICENSE",
        "x-links": ["https://www.iso.org/standard/74575.html"],
        "anyOf": [
          { "title": "Afro-Asiatic languages", "x-name-french": "afro-asiatiques, langues", "const": "afa" },
          { "title": "Algonquian languages", "x-name-french": "algonquines, langues", "const": "alg" },
          { "title": "Apache languages", "x-name-french": "apaches, langues", "const": "apa" },
          { "title": "Artificial languages", "x-name-french": "artificielles, langues", "const": "art" }
        ]
      };

      // Should be detected as standalone (has anyOf, no $defs)
      expect(isStandalonePrimitiveSchema(isoLanguageFamilySchema)).toBe(true);

      // Should extract name from $id
      const name = extractPrimitiveNameFromSchema(isoLanguageFamilySchema);
      expect(name).toBe('set-5');

      // Should determine category as string (from anyOf with string consts)
      const category = determineCategoryFromSchema(isoLanguageFamilySchema);
      expect(category).toBe('string');

      // Metadata should be preserved
      expect(isoLanguageFamilySchema['x-license']).toBeDefined();
      expect(isoLanguageFamilySchema['x-links']).toBeDefined();
      expect(isoLanguageFamilySchema.description).toBe('A three-letter code for language families and groups from ISO 639-5');
      expect(isoLanguageFamilySchema.title).toBe('ISO 639-5:2023 Language Family Code');

      // anyOf options should preserve their metadata
      const firstOption = isoLanguageFamilySchema.anyOf[0];
      expect(firstOption['x-name-french']).toBe('afro-asiatiques, langues');
    });
  });

  describe('URL Import Support', () => {
    // Helper to extract primitive name from URL
    const extractNameFromUrl = (url: string, schema: Record<string, unknown>): string => {
      // First try to extract from schema
      const schemaName = extractPrimitiveNameFromSchema(schema);
      if (schemaName !== 'imported-primitive') {
        return schemaName;
      }

      // Fall back to URL path
      try {
        const urlPath = new URL(url).pathname;
        const urlFilename = urlPath.split('/').pop() || '';
        return extractPrimitiveNameFromSchema(schema, urlFilename);
      } catch {
        return 'imported-primitive';
      }
    };

    it('should validate URL format', () => {
      const validUrls = [
        'https://example.com/schema.json',
        'http://localhost:8000/api/schema',
        'https://raw.githubusercontent.com/user/repo/main/schema.json'
      ];

      const invalidUrls = [
        'not-a-url',
        'just some text'
      ];

      validUrls.forEach(url => {
        expect(() => new URL(url)).not.toThrow();
      });

      invalidUrls.forEach(url => {
        expect(() => new URL(url)).toThrow();
      });
    });

    it('should extract primitive name from URL path when schema has no $id', () => {
      const schema = {
        type: 'string',
        format: 'email'
      };
      const url = 'https://example.com/schemas/email-address.json';

      const name = extractNameFromUrl(url, schema);
      expect(name).toBe('email-address');
    });

    it('should prefer schema $id over URL path for name extraction', () => {
      const schema = {
        $id: 'https://schemas.example.com/percentage',
        type: 'number'
      };
      const url = 'https://cdn.example.com/random-file-name.json';

      const name = extractNameFromUrl(url, schema);
      expect(name).toBe('percentage');
    });

    it('should handle URL with no file extension', () => {
      const schema = {
        type: 'string'
      };
      const url = 'https://api.example.com/schemas/phone-number';

      const name = extractNameFromUrl(url, schema);
      expect(name).toBe('phone-number');
    });

    it('should handle URL response parsing for JSON', () => {
      const jsonContent = JSON.stringify({
        $defs: {
          Email: { type: 'string', format: 'email' }
        }
      });

      const parsed = parseSchemaContent(jsonContent);
      expect(parsed).not.toBeNull();

      const defs = extractDefinitions(parsed!);
      expect(Object.keys(defs)).toContain('Email');
    });

    it('should handle URL response parsing for YAML', () => {
      const yamlContent = `
$defs:
  PhoneNumber:
    type: string
    pattern: "^\\\\+[1-9]"
`;

      const parsed = parseSchemaContent(yamlContent);
      expect(parsed).not.toBeNull();

      const defs = extractDefinitions(parsed!);
      expect(Object.keys(defs)).toContain('PhoneNumber');
    });

    it('should handle standalone schema from URL', () => {
      const standaloneSchema = {
        "$id": "https://schemas.sourcemeta.com/iso/percentage",
        "type": "number",
        "minimum": 0,
        "maximum": 100
      };

      expect(isStandalonePrimitiveSchema(standaloneSchema)).toBe(true);

      const name = extractPrimitiveNameFromSchema(standaloneSchema);
      expect(name).toBe('percentage');
    });
  });
});

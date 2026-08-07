'use server';

import { createClass, addPropertyToClass, updateClass, getClassesForVersion, getClassWithPropertiesAndTags, deleteClassPropertiesForClass } from './helper';
import { getImporter, NormalizedClass, type NormalizedProperty } from '../importers';
import { cookies } from 'next/headers';
import { mergeClasses, type MergeStrategy, type ArrayMergeStrategy } from '../../src/app/utils/schema-merge';
import { extractPaths, extractSecuritySchemes } from '../../src/app/utils/openapi-import';
import { importOpenAPIPathsAndSecurity } from './import-openapi-paths-security';

export interface ImportClassesInput {
  versionId: string;
  projectId: string;
  document: any;
  /** Import format; determines which importer is used (default: openapi). #299 Arazzo */
  sourceKind?: 'openapi' | 'arazzo';
  selectedSchemas: string[];
  /** When true, apply naming convention to class and property names (#581) */
  applyNamingConvention?: boolean;
  /** Convention for class names (default: PascalCase) */
  classNamingConvention?: 'PascalCase' | 'camelCase' | 'snake_case' | 'kebab-case' | 'none';
  /** Convention for property names (default: camelCase) */
  propertyNamingConvention?: 'PascalCase' | 'camelCase' | 'snake_case' | 'kebab-case' | 'none';
  /** Optional map: schema key → class name. Applied with smart naming from schema context (#753). */
  classNameMap?: Record<string, string>;
  /** Optional prefix applied to every class name after naming convention (#755). */
  classPrefix?: string;
  /** Optional suffix applied to every class name after naming convention (#755). */
  classSuffix?: string;
  /**
   * Optional type mapping: external type key → internal JSON Schema (#757).
   * Key format: "type" or "type:format" (e.g. "string:date-time", "integer:int32").
   */
  typeMapping?: Record<string, any>;
  /** Optional default values per type during import (#758). Key = external type key. */
  defaultValues?: Record<string, any>;
  /** Optional required field overrides per schema/property during import (#759). schema key -> { property name -> boolean }. */
  requiredOverrides?: Record<string, Record<string, boolean>>;
  /** Optional property description overrides per schema/property during import (#760). schema key -> { property name -> description }. */
  descriptionOverrides?: Record<string, Record<string, string>>;
  /** When true, auto-generate example values for properties that do not have an example (#761). */
  generateExamples?: boolean;
  /** When true, replace existing classes with the same name using the imported schema (#587). */
  overwriteExisting?: boolean;
  /** When set with overwriteExisting, merge existing with imported instead of full replace (#588). */
  mergeStrategy?: MergeStrategy;
  /** Per-property merge strategy (#593): schema key → property path (dot for nested) → strategy. Missing = use mergeStrategy. */
  propertyMergeStrategies?: Record<string, Record<string, MergeStrategy>>;
  /** How to merge array-valued schema fields (required, enum) when merging (#595). Default: replace. */
  arrayMergeStrategy?: ArrayMergeStrategy;
}

/** One class the import wrote, with the id it landed under (private-suite#2675). */
export interface ImportedClassRef {
  /** The `apiome.classes` UUID the class now lives at. */
  id: string;
  /** The class name as written, after naming conventions and renames. */
  name: string;
  /** True for a newly created class; false when an existing class was overwritten or merged. */
  created: boolean;
}

/** One selected entry the import did not write, and why (private-suite#2675). */
export interface ImportSkippedClass {
  /** The class name as it would have been written. */
  name: string;
  /** Why the entry was skipped, in the user's terms. */
  reason: string;
}

export interface ImportClassesResult {
  success: boolean;
  importedCount?: number;
  skippedCount?: number;
  error?: string;
  importedClasses?: string[];
  /**
   * The written classes with their ids, in write order (private-suite#2675).
   * `importedClasses` above predates this and carries the same names; it stays
   * for existing callers.
   */
  imported?: ImportedClassRef[];
  /** The skipped entries by name, each with its reason (private-suite#2675). */
  skipped?: ImportSkippedClass[];
  /** Normalization warnings (e.g. reserved name detection #756). */
  warnings?: string[];
}

/** Convert DB class (from getClassWithPropertiesAndTags) to NormalizedClass for merge (#588). */
function dbClassToNormalized(raw: any): NormalizedClass {
  const schema = typeof raw.schema === 'string' ? JSON.parse(raw.schema) : raw.schema;
  const props = raw.properties || [];
  const byParent = new Map<string | null, any[]>();
  byParent.set(null, []);
  for (const p of props) {
    const key = p.parent_id ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(p);
  }
  function buildChildren(parentId: string | null): NormalizedProperty[] {
    const list = byParent.get(parentId) || [];
    return list.map((p: any) => ({
      name: p.name,
      data: p.data || {},
      description: p.description ?? undefined,
      children: byParent.has(p.id) && byParent.get(p.id)!.length > 0 ? buildChildren(p.id) : undefined,
    }));
  }
  const rootChildren = buildChildren(null);
  return {
    name: raw.name,
    description: raw.description ?? undefined,
    schema: schema || { type: 'object' },
    properties: rootChildren,
  };
}

// Stable JSON stringify that sorts object keys to ensure consistent signatures
function stableStringify(obj: any): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(item => stableStringify(item)).join(',') + ']';
  }
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map(key => JSON.stringify(key) + ':' + stableStringify(obj[key]));
  return '{' + pairs.join(',') + '}';
}

async function writeClassWithProperties(
  projectId: string,
  versionId: string,
  cls: NormalizedClass,
  propertyIdMap: Map<string, string>
) {
  const resClass = JSON.parse(await createClass(versionId, cls.name, cls.description || null, cls.schema || { type: 'object' }));
  if (!resClass.success) throw new Error(resClass.error || 'Failed to create class');
  const classId = resClass.class.id as string;

  const linkRec = async (classId: string, props: any[], parentId: string | null = null) => {
    for (const p of props || []) {
      let propertyId: string | null = null;
      const isReference = p.data.$ref || (p.data.type === 'array' && p.data.items?.$ref);
      if (!isReference) {
        const sig = stableStringify(p.data);
        propertyId = propertyIdMap.get(sig) || null;

        // Database constraint requires: property_id IS NOT NULL OR data contains $ref
        if (propertyId === null) {
          console.warn(`Skipping property "${p.name}" in class "${cls.name}" - no library entry found`);
          if (p.children && p.children.length) {
            console.warn(`Also skipping ${p.children.length} child properties of "${p.name}"`);
          }
          continue;
        }
      }
      const addRes = JSON.parse(
        await addPropertyToClass(classId, propertyId, p.name, p.description || null, p.data, parentId)
      );
      if (!addRes.success) throw new Error(addRes.error || 'Failed to add property');
      const newId = addRes.classProperty.id as string;
      if (p.children && p.children.length) await linkRec(classId, p.children, newId);
    }
  };

  await linkRec(classId, cls.properties || [], null);
  return classId;
}

async function overwriteClassWithProperties(
  classId: string,
  cls: NormalizedClass,
  propertyIdMap: Map<string, string>
) {
  await deleteClassPropertiesForClass(classId);
  const updateRes = JSON.parse(
    await updateClass(classId, cls.name, cls.description || null, cls.schema || { type: 'object' })
  );
  if (!updateRes.success) throw new Error(updateRes.error || 'Failed to update class');

  const linkRec = async (cid: string, props: any[], parentId: string | null = null) => {
    for (const p of props || []) {
      let propertyId: string | null = null;
      const isReference = p.data.$ref || (p.data.type === 'array' && p.data.items?.$ref);
      if (!isReference) {
        const sig = stableStringify(p.data);
        propertyId = propertyIdMap.get(sig) || null;
        if (propertyId === null) {
          console.warn(`Skipping property "${p.name}" in class "${cls.name}" - no library entry found`);
          if (p.children && p.children.length) {
            console.warn(`Also skipping ${p.children.length} child properties of "${p.name}"`);
          }
          continue;
        }
      }
      const addRes = JSON.parse(
        await addPropertyToClass(cid, propertyId, p.name, p.description || null, p.data, parentId)
      );
      if (!addRes.success) throw new Error(addRes.error || 'Failed to add property');
      const newId = addRes.classProperty.id as string;
      if (p.children && p.children.length) await linkRec(cid, p.children, newId);
    }
  };

  await linkRec(classId, cls.properties || [], null);
}

export async function importClassesToVersion(input: ImportClassesInput): Promise<ImportClassesResult> {
  try {
    const { versionId, projectId, document, selectedSchemas, overwriteExisting, mergeStrategy, propertyMergeStrategies, arrayMergeStrategy } = input;

    if (!versionId || !projectId) {
      return { success: false, error: 'Version ID and Project ID are required' };
    }

    if (!selectedSchemas || selectedSchemas.length === 0) {
      return { success: false, error: 'No schemas selected for import' };
    }

    const existingNameToId = new Map<string, string>();
    if (overwriteExisting) {
      const classesJson = await getClassesForVersion(versionId);
      const classes = JSON.parse(classesJson) as Array<{ id: string; name: string }>;
      for (const c of classes) {
        existingNameToId.set(c.name, c.id);
      }
    }

    const sourceKind = input.sourceKind ?? 'openapi';
    const importer = getImporter(sourceKind);
    if (!importer) {
      return { success: false, error: `${sourceKind} importer not available` };
    }

    const norm = importer.normalize({
      document,
      options: {
        selectedSchemas,
        applyNamingConvention: input.applyNamingConvention ?? true,
        classNamingConvention: input.classNamingConvention ?? 'PascalCase',
        propertyNamingConvention: input.propertyNamingConvention ?? 'camelCase',
        classNameMap: input.classNameMap,
        classPrefix: input.classPrefix,
        classSuffix: input.classSuffix,
        typeMapping: input.typeMapping,
        defaultValues: input.defaultValues,
        requiredOverrides: input.requiredOverrides,
        descriptionOverrides: input.descriptionOverrides,
        generateExamples: input.generateExamples,
      },
    });
    if (norm.warnings.length) {
      console.log('Normalization warnings:', norm.warnings);
    }

    // Build property library: collect all unique non-reference properties
    const propertyMap = new Map<string, { data: any; description?: string; names: Set<string> }>();
    const propertyIdMap = new Map<string, string>(); // sig -> propertyId

    const collectProperties = (props: any[]) => {
      for (const p of props || []) {
        const isReference = p.data.$ref || (p.data.type === 'array' && p.data.items?.$ref);
        if (!isReference) {
          const sig = stableStringify(p.data);
          if (!propertyMap.has(sig)) {
            propertyMap.set(sig, { data: p.data, description: p.description, names: new Set<string>() });
          }
          propertyMap.get(sig)!.names.add(p.name);
        }
        if (p.children && p.children.length) collectProperties(p.children);
      }
    };

    for (const cls of norm.classes) {
      collectProperties(cls.properties || []);
    }

    // When merging (#588), load existing classes and merge; collect properties from merged result
    const mergedClassesByName = new Map<string, NormalizedClass>();
    if (overwriteExisting && mergeStrategy) {
      for (const cls of norm.classes) {
        const existingId = existingNameToId.get(cls.name);
        if (!existingId) continue;
        const existingJson = await getClassWithPropertiesAndTags(existingId);
        const existingRaw = JSON.parse(existingJson);
        if (!existingRaw) continue;
        const existingNorm = dbClassToNormalized(existingRaw);
        const merged = mergeClasses(existingNorm, cls, mergeStrategy, {
          schemaKey: cls.originalSchemaKey,
          propertyMergeStrategies,
          arrayMergeStrategy,
        });
        mergedClassesByName.set(cls.name, merged);
        collectProperties(merged.properties || []);
      }
    }

    // Create properties in the library via REST API (through Next.js API route)
    const cookieStore = await cookies();
    // Build cookie header string from cookies
    const cookieHeader = cookieStore.getAll()
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join('; ');
    
    // Get the base URL for API calls - use internal URL for server-side calls
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    
    for (const [sig, entry] of propertyMap.entries()) {
      const primaryName = Array.from(entry.names).sort()[0];
      try {
        // Call the Next.js API route which handles authentication via session
        const headers: Record<string, string> = { 
          'Content-Type': 'application/json',
        };
        if (cookieHeader) {
          headers['Cookie'] = cookieHeader; // Forward cookies for session authentication
        }
        
        const response = await fetch(`${baseUrl}/api/properties/${projectId}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            name: primaryName,
            description: entry.description || null,
            data: entry.data,
          }),
        });
        const res = await response.json();
        if (res.success && res.property) {
          propertyIdMap.set(sig, res.property.id);
        } else {
          console.warn(`Failed to create property "${primaryName}": ${res.error || 'Unknown error'}`);
        }
      } catch (error: any) {
        console.warn(`Failed to create property "${primaryName}": ${error.message || 'Unknown error'}`);
      }
    }

    // Import classes (importer already filtered by selectedSchemas; names may be transformed by naming convention)
    const importedClasses: string[] = [];
    const imported: ImportedClassRef[] = [];
    const skipped: ImportSkippedClass[] = [];
    let skippedCount = 0;

    for (const cls of norm.classes) {
      const existingClassId = overwriteExisting ? existingNameToId.get(cls.name) : undefined;
      const classToWrite = mergedClassesByName.get(cls.name) ?? cls;
      try {
        if (existingClassId) {
          await overwriteClassWithProperties(existingClassId, classToWrite, propertyIdMap);
          importedClasses.push(classToWrite.name);
          imported.push({ id: existingClassId, name: classToWrite.name, created: false });
        } else {
          const classId = await writeClassWithProperties(projectId, versionId, classToWrite, propertyIdMap);
          importedClasses.push(classToWrite.name);
          imported.push({ id: classId, name: classToWrite.name, created: true });
        }
      } catch (error: any) {
        // If class already exists and we weren't overwriting, skip it
        if (!existingClassId && error.message?.includes('already exists')) {
          console.log(`Class "${cls.name}" already exists, skipping`);
          skippedCount++;
          skipped.push({
            name: cls.name,
            reason: 'a class with this name already exists in this version',
          });
        } else {
          throw error;
        }
      }
    }

    if (sourceKind === 'openapi' && document) {
      const paths = extractPaths(document);
      const securitySchemes = extractSecuritySchemes(document);
      if (paths.length > 0 || securitySchemes.length > 0) {
        const pathResult = await importOpenAPIPathsAndSecurity(versionId, paths, securitySchemes);
        if (!pathResult.success) {
          console.warn('Paths/security import had issues:', pathResult.error);
        }
      }
    }

    return {
      success: true,
      importedCount: importedClasses.length,
      skippedCount,
      importedClasses,
      imported,
      skipped: skipped.length > 0 ? skipped : undefined,
      warnings: norm.warnings.length > 0 ? norm.warnings : undefined,
    };
  } catch (error: any) {
    console.error('Error importing classes:', error);
    return {
      success: false,
      error: error.message || 'An error occurred during import',
    };
  }
}


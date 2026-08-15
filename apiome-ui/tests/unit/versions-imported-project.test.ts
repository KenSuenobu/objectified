import { findNewlyImportedProject } from '@/app/ade/dashboard/versions/imported-project';

/**
 * Newly-imported project resolution behind the Versions screen's Import button (#5260).
 */

interface TestProject {
  id: string;
  name: string;
  publishable?: boolean;
}

const project = (id: string, over: Partial<TestProject> = {}): TestProject => ({
  id,
  name: over.name ?? `Project ${id}`,
  ...(over.publishable === undefined ? {} : { publishable: over.publishable }),
});

describe('findNewlyImportedProject', () => {
  it('returns the single project the import added', () => {
    const before = [project('p1'), project('p2')];
    const after = [...before, project('p3', { name: 'Imported API' })];
    expect(findNewlyImportedProject(before, after)).toEqual(
      expect.objectContaining({ id: 'p3', name: 'Imported API' }),
    );
  });

  it('returns null when nothing new appeared', () => {
    const before = [project('p1'), project('p2')];
    expect(findNewlyImportedProject(before, [...before])).toBeNull();
  });

  it('returns null when the list shrank or was reordered without additions', () => {
    const before = [project('p1'), project('p2')];
    expect(findNewlyImportedProject(before, [project('p2'), project('p1')])).toBeNull();
    expect(findNewlyImportedProject(before, [project('p1')])).toBeNull();
  });

  it('ignores catalog items, which the Versions selector never offers', () => {
    const before = [project('p1')];
    const after = [...before, project('cat-1', { publishable: false })];
    expect(findNewlyImportedProject(before, after)).toBeNull();
  });

  it('picks the publishable project when a catalog item appeared alongside it', () => {
    const before = [project('p1')];
    const after = [
      ...before,
      project('cat-1', { publishable: false }),
      project('p2', { publishable: true }),
    ];
    expect(findNewlyImportedProject(before, after)).toEqual(
      expect.objectContaining({ id: 'p2' }),
    );
  });

  it('treats a project with no publishable flag as publishable (older payloads)', () => {
    const before = [project('p1')];
    const after = [...before, project('p2')];
    expect(findNewlyImportedProject(before, after)?.id).toBe('p2');
  });

  it('declines to guess when several new publishable projects appeared', () => {
    const before = [project('p1')];
    const after = [...before, project('p2'), project('p3')];
    expect(findNewlyImportedProject(before, after)).toBeNull();
  });

  it('treats an empty prior list as "everything is new"', () => {
    expect(findNewlyImportedProject([], [project('p1')])?.id).toBe('p1');
    expect(findNewlyImportedProject([], [])).toBeNull();
  });
});

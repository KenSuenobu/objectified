/**
 * Render tests for the bundle file tree (MFX-43.2, #4362).
 *
 * The tree must render folders and files (folders collapsible), badge per-file finding counts and
 * roll them up to folders, mark the active file, and call back on selection.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { BundleTree } from '../src/app/components/ade/dashboard/export/BundleTree';
import {
  buildBundleManifest,
  buildBundleTree,
  countFindingsByFile,
} from '../src/app/components/ade/dashboard/export/exportBundle';

const manifest = buildBundleManifest([
  { path: 'petstore.proto', text: 'syntax = "proto3";' },
  { path: 'com/example/User.avsc', text: '{"type":"record"}' },
  { path: 'com/example/Order.avsc', text: '{"type":"record"}' },
]);
const nodes = buildBundleTree(manifest.files);
const counts = countFindingsByFile(
  [{ file: 'com/example/User.avsc' }],
  [{ file: 'com/example/Order.avsc', severity: 'warning' }],
);

function renderTree(onSelect = jest.fn(), activePath: string | null = 'petstore.proto') {
  render(
    <BundleTree nodes={nodes} countsByPath={counts} activePath={activePath} onSelect={onSelect} />,
  );
  return onSelect;
}

describe('BundleTree (MFX-43.2)', () => {
  it('renders folders and files', () => {
    renderTree();
    expect(screen.getByTestId('bundle-tree')).toBeInTheDocument();
    expect(screen.getByTestId('bundle-tree-folder-com')).toBeInTheDocument();
    expect(screen.getByTestId('bundle-tree-folder-com/example')).toBeInTheDocument();
    expect(screen.getByTestId('bundle-tree-file-petstore.proto')).toBeInTheDocument();
    expect(screen.getByTestId('bundle-tree-file-com/example/User.avsc')).toBeInTheDocument();
  });

  it('badges per-file findings and rolls them up to the folder', () => {
    renderTree();
    // HIVE-8.3: the badge names a vocabulary tone, the same one the Verify lens badge uses.
    // The error-bearing file badges danger.
    const userBadge = screen.getByTestId('bundle-tree-badge-com/example/User.avsc');
    expect(userBadge).toHaveAttribute('data-tone', 'danger');
    expect(userBadge).toHaveTextContent('1');
    // The warning-only file badges warn.
    expect(screen.getByTestId('bundle-tree-badge-com/example/Order.avsc')).toHaveAttribute(
      'data-tone',
      'warn',
    );
    // The folder rolls up an error + a warning → danger tone (blocking dominates).
    expect(screen.getByTestId('bundle-tree-badge-com/example')).toHaveAttribute(
      'data-tone',
      'danger',
    );
    // The clean primary file carries no badge.
    expect(screen.queryByTestId('bundle-tree-badge-petstore.proto')).not.toBeInTheDocument();
  });

  it('marks the active file and calls back on selection', () => {
    const onSelect = renderTree(jest.fn(), 'petstore.proto');
    expect(screen.getByTestId('bundle-tree-file-petstore.proto')).toHaveAttribute('data-selected', 'true');

    fireEvent.click(screen.getByTestId('bundle-tree-file-com/example/User.avsc'));
    expect(onSelect).toHaveBeenCalledWith('com/example/User.avsc');
  });

  it('collapses a folder to hide its files', () => {
    renderTree();
    expect(screen.getByTestId('bundle-tree-file-com/example/User.avsc')).toBeInTheDocument();
    // Collapse the inner folder. The folder row *is* the tree item (MFX-41.5 — no control nested
    // inside a `treeitem`), so the row itself is what toggles.
    fireEvent.click(screen.getByTestId('bundle-tree-folder-com/example'));
    expect(screen.queryByTestId('bundle-tree-file-com/example/User.avsc')).not.toBeInTheDocument();
  });
});

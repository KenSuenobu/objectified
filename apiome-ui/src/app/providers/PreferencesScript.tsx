import * as React from 'react';
import { preferencesBootScript } from '../config/preferences';

/**
 * The blocking preferences script, for `<head>` (HIVE-1.3, #5276).
 *
 * Must be rendered before any stylesheet-dependent content so the document is painted
 * once, with the stored theme and root font size already on `<html>`. Rendering it later —
 * or letting Next defer it — reintroduces the flash it exists to remove, which is why it
 * is a plain inline `<script>` rather than `next/script`: `beforeInteractive` still runs
 * after the first paint of a static shell.
 *
 * The source is generated from `src/app/config/preferences.ts`, so it cannot drift from
 * what `PreferencesProvider` does after hydration.
 *
 * @returns A `<script>` element carrying the generated source.
 */
export default function PreferencesScript() {
  return (
    <script
      id="hive-preferences"
      // The source is built from module constants, never from user input.
      dangerouslySetInnerHTML={{ __html: preferencesBootScript() }}
    />
  );
}

import {
  getRefreshStatusPresentation,
  type RefreshStatusCode,
} from '@/app/components/ade/dashboard/repositories/repository-refresh-status-chip-copy';
import { REFRESH_STATUS_TONE } from '@/app/components/ade/repositories/repositoriesModel';

describe('getRefreshStatusPresentation', () => {
  const cases: Array<[RefreshStatusCode, string]> = [
    ['up-to-date', 'Up to date'],
    ['stale', 'Stale'],
    ['refreshing', 'Refreshing'],
    ['failed', 'Failed'],
    ['diverged', 'Diverged'],
  ];

  test.each(cases)('maps %s to its label and tone', (code, label) => {
    const p = getRefreshStatusPresentation(code);
    expect(p.label).toBe(label);
    expect(p.tone).toBe(code);
    expect(p.description.length).toBeGreaterThan(0);
  });

  test('falls back to up-to-date for unknown codes', () => {
    expect(getRefreshStatusPresentation('bogus').tone).toBe('up-to-date');
    expect(getRefreshStatusPresentation('bogus').label).toBe('Up to date');
  });

  test('falls back to up-to-date for null/undefined', () => {
    expect(getRefreshStatusPresentation(null).tone).toBe('up-to-date');
    expect(getRefreshStatusPresentation(undefined).tone).toBe('up-to-date');
  });
});

describe('REFRESH_STATUS_TONE', () => {
  test('every refresh state resolves to a tone in the shared vocabulary', () => {
    // HIVE-7.5 (#5322) retired `refreshStatusChipToneClasses`, which returned a frozen
    // Tailwind palette string per state. The tone table replaced it; what has to hold is that
    // it still covers all five states and still tells them apart.
    const codes: RefreshStatusCode[] = [
      'up-to-date',
      'stale',
      'refreshing',
      'failed',
      'diverged',
    ];
    const tones = codes.map((code) => REFRESH_STATUS_TONE[code]);
    tones.forEach((tone) => expect(typeof tone).toBe('string'));
    expect(new Set(tones).size).toBe(codes.length);
  });
});

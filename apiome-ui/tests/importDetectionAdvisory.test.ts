/**
 * The Projects importer routes unplaceable bytes to detection (FMT-1.1, #5412).
 *
 * The acceptance criterion: the importer no longer rejects an unknown extension outright; it routes
 * the bytes to `POST /v1/import/detect` and reports the detector's verdict. These tests pin the
 * verdict wording and the never-throw contract of the call that produces it.
 */

import { jest } from '@jest/globals';
import {
  describeDetectionVerdict,
  detectAndDescribe,
  type DetectionResponse,
} from '../src/app/components/ade/import/importDetectionAdvisory';

/** A detector response that recognized an importable format. */
function matched(format: string, importable = true, ambiguous = false): DetectionResponse {
  return {
    matched: true,
    ambiguous,
    detected: { format, confidence: 0.95, reason: 'marker', source_key: format, importable },
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('describeDetectionVerdict', () => {
  it('names the format and points at the importer that can read it', () => {
    const message = describeDetectionVerdict('api.tsp', matched('typespec'));
    expect(message).toContain('api.tsp');
    expect(message).toContain('typespec');
    expect(message).toContain('Catalog importer');
  });

  it('says so plainly when nothing can import the detected format', () => {
    const message = describeDetectionVerdict('legacy.dat', matched('some-format', false));
    expect(message).toContain('no import source can read that format yet');
    expect(message).not.toContain('Catalog importer');
  });

  it('flags an ambiguous verdict rather than presenting a guess as fact', () => {
    const message = describeDetectionVerdict('thing.json', matched('jtd', true, true));
    expect(message).toContain('ambiguous');
  });

  it('stays silent when the detector recognized nothing', () => {
    // The analyzer's own parse error is the better message; a vague second line would muddy it.
    expect(describeDetectionVerdict('mystery.bin', { matched: false })).toBeNull();
    expect(describeDetectionVerdict('mystery.bin', null)).toBeNull();
  });

  it('stays silent on a matched response carrying no usable format name', () => {
    expect(describeDetectionVerdict('x.bin', { matched: true, detected: { format: '   ' } })).toBeNull();
    expect(describeDetectionVerdict('x.bin', { matched: true, detected: null })).toBeNull();
  });
});

describe('detectAndDescribe', () => {
  it('sends the bytes and the filename to the detector', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(matched('typespec')) }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const message = await detectAndDescribe('model Foo {}', 'api.tsp');

    expect(fetchMock).toHaveBeenCalledWith('/api/import/detect', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body).toEqual({ text: 'model Foo {}', filename: 'api.tsp' });
    expect(message).toContain('typespec');
  });

  it('returns null on a non-ok response rather than surfacing a status code', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
    ) as unknown as typeof fetch;
    await expect(detectAndDescribe('x', 'a.bin')).resolves.toBeNull();
  });

  it('never rejects when the detector is unreachable', async () => {
    // This runs after an analysis has already failed; a network error must not replace the
    // analyzer's own message with something the user can do nothing about.
    global.fetch = jest.fn(() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    await expect(detectAndDescribe('x', 'a.bin')).resolves.toBeNull();
  });

  it('never rejects when the response is not JSON', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.reject(new Error('not json')) }),
    ) as unknown as typeof fetch;
    await expect(detectAndDescribe('x', 'a.bin')).resolves.toBeNull();
  });
});

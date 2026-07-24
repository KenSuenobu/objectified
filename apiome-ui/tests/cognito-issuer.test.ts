/**
 * Cognito issuer helper tests (OLO-9.4, #4987) for `lib/auth/cognito-issuer.ts`.
 *
 * Pins the engine-neutral Cognito facts: provider slug (`aws`), issuer base URL (trailing slash
 * trimmed, blank counts as unset), and membership on the auto-link trust list.
 */
import { describe, test, expect } from '@jest/globals';

import { AWS_PROVIDER_ID, cognitoIssuerBaseUrl } from '../lib/auth/cognito-issuer';
import { AUTO_LINK_TRUSTED_PROVIDERS, LINKABLE_PROVIDERS } from '../lib/auth/account-resolution';

describe('cognito issuer env contract', () => {
  test('provider id is the stable slug aws', () => {
    expect(AWS_PROVIDER_ID).toBe('aws');
  });

  test('unset / blank issuer yields empty string', () => {
    expect(cognitoIssuerBaseUrl({})).toBe('');
    expect(cognitoIssuerBaseUrl({ COGNITO_ISSUER: '   ' })).toBe('');
  });

  test('COGNITO_ISSUER is trimmed and trailing slash stripped', () => {
    expect(
      cognitoIssuerBaseUrl({
        COGNITO_ISSUER: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEf/',
      })
    ).toBe('https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEf');
    expect(cognitoIssuerBaseUrl({ COGNITO_ISSUER: '  http://localhost:9007/cognito  ' })).toBe(
      'http://localhost:9007/cognito'
    );
  });

  test('aws is on the auto-link trust and linkable sets', () => {
    expect(AUTO_LINK_TRUSTED_PROVIDERS.has('aws')).toBe(true);
    expect(LINKABLE_PROVIDERS.has('aws')).toBe(true);
  });
});

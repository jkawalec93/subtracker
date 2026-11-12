import { describe, expect, it } from 'vitest';
import { DOMAIN_VERSION } from '@domain/index';

describe('SubTrack setup smoke test', () => {
  it('exports domain version cleanly', () => {
    expect(DOMAIN_VERSION).toBe('1.0.0-mvp');
  });
});


import { BadRequestException } from '@nestjs/common';
import { assertTrustedLocalAiUrl } from './local-ai-url';

describe('assertTrustedLocalAiUrl', () => {
  it('accepts the default local Ollama URL', () => {
    expect(assertTrustedLocalAiUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
  });

  it('rejects a non-local host by default', () => {
    expect(() => assertTrustedLocalAiUrl('http://example.com/v1')).toThrow(BadRequestException);
  });

  it('allows an explicitly configured host', () => {
    expect(assertTrustedLocalAiUrl('http://ollama.lan:11434/v1', 'ollama.lan')).toBe('http://ollama.lan:11434/v1');
  });
});

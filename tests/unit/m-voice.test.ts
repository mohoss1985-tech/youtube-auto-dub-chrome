// M (v1.2.2): default male French neural voice = Pierre (upmc); Tom stays selectable.
import { describe, it, expect } from 'vitest';
import { defaultNeuralVoice, neuralVoice, neuralVoicesFor, recommendedModels } from '../../src/content/voice/neural-catalog';

describe('M: male French voice catalog', () => {
  it('default male French voice is Pierre (fr_FR-upmc-medium#pierre)', () => {
    const v = defaultNeuralVoice('fr', 'male');
    expect(v?.id).toBe('fr_FR-upmc-medium#pierre');
    expect(v?.speaker).toBe('pierre');
    expect(v?.license).toMatch(/CC BY-SA 4\.0/);
  });
  it('the Download button fetches Siwis + upmc (Pierre), not Tom', () => {
    expect(recommendedModels('fr')).toEqual(['fr_FR-siwis-medium', 'fr_FR-upmc-medium']);
  });
  it('Tom is still listed and selectable, ranked below Pierre', () => {
    const fr = neuralVoicesFor('fr').map((v) => v.id);
    expect(fr).toContain('fr_FR-tom-medium');
    expect(fr.indexOf('fr_FR-upmc-medium#pierre')).toBeLessThan(fr.indexOf('fr_FR-tom-medium'));
    expect(neuralVoice('fr_FR-tom-medium')?.gender).toBe('male');
  });
  it('the female default is unchanged (Siwis)', () => {
    expect(defaultNeuralVoice('fr', 'female')?.id).toBe('fr_FR-siwis-medium');
  });
  it('model#speaker resolves any speaker of a known multi-speaker model', () => {
    expect(neuralVoice('fr_FR-upmc-medium#jessica')?.name).toBe('Jessica');
    expect(neuralVoice('es_ES-sharvard-medium#X')).toMatchObject({ model: 'es_ES-sharvard-medium', speaker: 'X', recommended: false });
    expect(neuralVoice('fr_FR-unknown-medium#a')).toBeUndefined();
  });
});

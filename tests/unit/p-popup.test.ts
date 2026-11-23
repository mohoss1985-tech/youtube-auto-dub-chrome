// P (v1.1): popup neural engine panel, preferNeural auto-switch, robotic-voice hint.
import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeMock } from './helpers/chrome-mock';
import { initPopup, mockBackend, voiceLabel, type PopupBackend } from '../../src/popup/popup';
import type { NeuralModelState, VoiceInfo } from '../../src/shared/types';

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 5)); };
const W = (id: string, name: string, lang: string, gender: VoiceInfo['gender']): VoiceInfo => ({ id, name, lang, engine: 'webspeech', gender, quality: 10 });

function backend(over: Partial<PopupBackend>): PopupBackend {
  return { ...mockBackend('idle'), ...over };
}

describe('popup neural voices', () => {
  let root: HTMLElement;
  beforeEach(() => {
    installChromeMock();
    document.body.innerHTML = '<main id="x"></main>';
    root = document.getElementById('x')!;
  });

  it('suggests neural + Audrey (Premium)/Thomas (Enhanced) when only compact French voices exist', async () => {
    const be = backend({ listVoices: async () => [W('t', 'Thomas', 'fr-FR', 'male'), W('a', 'Amélie', 'fr-CA', 'female')] });
    await initPopup(root, { backend: be });
    await settle();
    const hint = root.querySelector('[data-quality-hint]');
    expect(hint?.textContent).toContain('Audrey (Premium)');
    expect(hint?.textContent).toContain('Thomas (Enhanced)');
    expect(hint?.textContent).toContain('Français');
  });

  it('no hint when an Enhanced voice is installed', async () => {
    const be = backend({ listVoices: async () => [W('t', 'Thomas (Enhanced)', 'fr-FR', 'male'), W('a', 'Amélie', 'fr-CA', 'female')] });
    await initPopup(root, { backend: be });
    await settle();
    expect(root.querySelector('[data-quality-hint]')).toBeNull();
  });

  it('switches French to the neural engine once downloaded (preferNeural)', async () => {
    let saved: Record<string, unknown> = {};
    const base = mockBackend('idle');
    const be = backend({
      neuralStatus: async (models): Promise<NeuralModelState[]> => models.map((model) => ({ model, ready: true })),
      saveSettings: async (p) => { saved = { ...saved, ...p }; return base.saveSettings(p); },
    });
    await initPopup(root, { backend: be });
    await settle();
    expect(saved.engine).toBe('neural');
    expect(root.querySelector('[data-neural]')?.textContent).toContain('Downloaded');
  });

  it('download button asks for the recommended pair and shows progress', async () => {
    const calls: (string[] | undefined)[] = [];
    const be = backend({
      loadSettings: async () => ({ ...(await mockBackend('idle').loadSettings()), engine: 'neural' }),
      neuralStatus: async (models, download) => {
        calls.push(download);
        return models.map((model) => (download ? { model, ready: false, progress: 0.5 } : { model, ready: false }));
      },
    });
    await initPopup(root, { backend: be });
    await settle();
    const btn = root.querySelector<HTMLButtonElement>('[data-action="neural-download"]');
    expect(btn?.textContent).toContain('127 MB');
    btn!.click();
    await settle();
    expect(calls).toContainEqual(['fr_FR-siwis-medium', 'fr_FR-tom-medium']);
    expect(root.querySelector('[data-neural] .progress')).not.toBeNull();
  });

  it('labels neural voices not yet downloaded', () => {
    expect(voiceLabel({ id: 'x', name: 'Tom', lang: 'fr-FR', engine: 'neural', gender: 'male', quality: 95 }, false)).toBe('Tom · Male · not downloaded');
  });
});

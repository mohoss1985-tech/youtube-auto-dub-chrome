// Wave 0 smoke for owner D: modules import; popup shell exists.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import * as ui from '../../src/content/ui/player-ui';
import * as feedback from '../../src/shared/feedback';
import * as popup from '../../src/popup/popup';

describe('D smoke', () => {
  it('exports the §8 names', () => {
    expect(ui.mountPlayerUI).toBeTypeOf('function');
    for (const f of [feedback.saveFeedback, feedback.getFeedback]) expect(f).toBeTypeOf('function');
    expect(popup.initPopup).toBeTypeOf('function');
  });

  it('popup.html loads popup.js and popup.css and has #app', () => {
    const html = fs.readFileSync('src/popup/popup.html', 'utf8');
    expect(html).toContain('popup.js');
    expect(html).toContain('popup.css');
    expect(html).toContain('id="app"');
  });
});

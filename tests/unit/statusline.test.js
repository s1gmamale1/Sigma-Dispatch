// tests/unit/statusline.test.js
const { compose } = require('../../plugin/lib/statusline-cli-lanes.cjs');
describe('compose', () => {
  test('appends summary to base bar', () => {
    expect(compose('RuFlo V3.6 | main', '🛠 codex●')).toBe('RuFlo V3.6 | main  🛠 codex●');
  });
  test('returns base unchanged when no lanes', () => {
    expect(compose('RuFlo V3.6 | main', '')).toBe('RuFlo V3.6 | main');
  });
});

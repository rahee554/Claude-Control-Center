import * as assert from 'assert';
import { parseReset, parseUsageOutput, runUsageCli } from '../../src/services/usageCli';

const SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 59% used · resets Oct 29, 4:19pm (Asia/Karachi)
Current week (all models): 54% used · resets Nov 2, 12:59pm (Asia/Karachi)
Current week (Fable): 0% used · resets Nov 2, 1pm (Asia/Karachi)
`;

describe('usage CLI parser', () => {
  const now = new Date(2026, 9, 29, 15, 0).getTime();
  it('parses session and weekly windows from real /usage output', () => {
    const u = parseUsageOutput(SAMPLE, now)!;
    assert.strictEqual(u.fiveHour!.usedPercentage, 59);
    assert.strictEqual(u.sevenDay!.usedPercentage, 54);
    assert.strictEqual(u.fiveHour!.resetsAt, new Date(2026, 9, 29, 16, 19).getTime() / 1000);
    assert.strictEqual(u.sevenDay!.resetsAt, new Date(2026, 10, 2, 12, 59).getTime() / 1000);
  });
  it('handles hour-only times and year rollover', () => {
    assert.strictEqual(parseReset('Jan 2, 1pm', now), new Date(2027, 0, 2, 13, 0).getTime() / 1000);
    assert.strictEqual(parseReset('12am', now), undefined);
  });
  it('returns undefined for unrelated output (API-key plan, errors)', () => {
    assert.strictEqual(parseUsageOutput('Usage is not available for API key users', now), undefined);
  });
  it('rejects a claude path with shell metacharacters', async () => {
    assert.strictEqual(await runUsageCli('claude & calc'), undefined);
  });
});

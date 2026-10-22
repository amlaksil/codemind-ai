import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gapPassProgressed } from './pipeline.js';
import { markAnswered, openRequirements } from './requirements.js';

test('a gap answered by one unscored round is met for the next, by the number the round was asked it under', () => {
  const scoring = {
    score: 70,
    requirements: [
      { text: 'Built APIs', verdict: 'met' },
      { text: 'Ran Kubernetes clusters in production', verdict: 'missing' },
      { text: 'Led a team', verdict: 'weak', quote: 'Led' },
    ],
    requiredSkillVerdicts: [{ skill: 'Terraform', verdict: 'missing' }, { skill: 'Go', verdict: 'weak' }],
    preferredSkillVerdicts: [{ skill: 'Rust', verdict: 'missing' }],
  };
  const open = openRequirements(scoring, { preferred: true });
  assert.deepEqual(open.map((o) => o.id), [1, 2, 3, 4, 5], 'requirements, then required skills, then nice-to-haves');
  // The round wrote lines for the clusters (1), Terraform (3) and Rust (5).
  const next = markAnswered(scoring, [1, 3, 5], { preferred: true });
  assert.deepEqual(openRequirements(next, { preferred: true }).map((o) => o.id), [2, 4]);
  assert.equal(next.score, 70, 'the score is the scorer\'s to move');
  assert.equal(scoring.requirements[1].verdict, 'missing', 'the scoring given is left as it was');
  // Without nice-to-haves as gaps the numbering has none, so id 5 names nothing.
  assert.deepEqual(openRequirements(markAnswered(scoring, [1, 3, 5]), {}).map((o) => o.id), [2, 4]);
  assert.equal(markAnswered(scoring, []), scoring, 'nothing answered, nothing copied');
});

test('a gap pass is kept when the score rose, or when more verdicts are met and the score fell no further than the noise', () => {
  const met = (n, score) => ({ score, requirements: Array.from({ length: n }, () => ({ verdict: 'met' })), requiredSkillVerdicts: [{ verdict: 'weak' }] });
  assert.equal(gapPassProgressed(met(3, 70), met(3, 72)), true, 'the score rose');
  assert.equal(gapPassProgressed(met(3, 70), met(5, 69)), true, 'two more verdicts met, one point down: noise');
  assert.equal(gapPassProgressed(met(3, 70), met(5, 66)), false, 'four points down is more than noise');
  assert.equal(gapPassProgressed(met(3, 70), met(3, 70)), false, 'nothing moved');
  assert.equal(gapPassProgressed(met(3, 70), met(2, 70)), false, 'a verdict lost');
});

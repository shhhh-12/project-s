import { describe, expect, it } from 'vitest';
import { RUBRIC } from '../config/rubric';
import pack from '../../knowledge/main_knowledge.md?raw';

/**
 * These tests fail if the rubric JSON and the markdown anchors ever drift apart.
 * The knowledge pack is the source of truth for scoring guidance; the JSON is used for
 * programmatic access (weights, ids). They must stay in sync.
 */
describe('knowledge pack drift', () => {
  it('every criterion name in the JSON exists in the markdown', () => {
    for (const criterion of RUBRIC.criteria) {
      expect(pack).toContain(criterion.name);
    }
  });

  it('every criterion has 4 anchors in the JSON', () => {
    for (const criterion of RUBRIC.criteria) {
      expect(criterion.anchors).toHaveLength(4);
    }
  });

  it('weights sum to 100', () => {
    const total = RUBRIC.criteria.reduce((sum, c) => sum + c.weight, 0);
    expect(total).toBe(100);
  });

  it('markdown contains anchored scales section', () => {
    expect(pack).toContain('Anchored scales');
  });

  it('markdown contains anchored scales for each criterion', () => {
    for (const criterion of RUBRIC.criteria) {
      // The markdown uses numbered bold headers like "**1. Opening and rapport**"
      const found = pack.includes(`**${criterion.name}**`) || pack.includes(`**. ${criterion.name}**`) || new RegExp(`\\*\\*\\d+\\.\\s*${criterion.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*\\*`).test(pack);
      expect(found, `Missing anchor for "${criterion.name}" in knowledge pack`).toBe(true);
    }
  });
});

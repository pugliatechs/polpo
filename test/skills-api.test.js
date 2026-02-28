const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseSkillFrontmatter, parseSkillsSearchOutput } = require('../src/server/api');

describe('skills API', () => {
  describe('parseSkillFrontmatter', () => {
    it('extracts name and description from valid frontmatter', () => {
      const content = '---\nname: test-skill\ndescription: A test skill\n---\n# Test';
      const result = parseSkillFrontmatter(content);
      assert.equal(result.name, 'test-skill');
      assert.equal(result.description, 'A test skill');
    });

    it('handles missing frontmatter gracefully', () => {
      const content = '# Just Markdown\nNo frontmatter here.';
      const result = parseSkillFrontmatter(content);
      assert.equal(result.name, '');
      assert.equal(result.description, '');
      assert.deepEqual(result.tags, []);
    });

    it('extracts tags from array format', () => {
      const content = '---\nname: my-skill\ndescription: Desc\ntags: [react, nextjs, performance]\n---\n# Skill';
      const result = parseSkillFrontmatter(content);
      assert.deepEqual(result.tags, ['react', 'nextjs', 'performance']);
    });

    it('extracts tags from plain comma format', () => {
      const content = '---\nname: my-skill\ndescription: Desc\ntags: react, vue, angular\n---\n# Skill';
      const result = parseSkillFrontmatter(content);
      assert.deepEqual(result.tags, ['react', 'vue', 'angular']);
    });

    it('handles empty frontmatter', () => {
      const content = '---\n---\n# Empty';
      const result = parseSkillFrontmatter(content);
      assert.equal(result.name, '');
      assert.equal(result.description, '');
    });

    it('handles quoted values', () => {
      const content = '---\nname: "my-skill"\ndescription: "A skill with quotes"\ntags: ["tag1", "tag2"]\n---\n';
      const result = parseSkillFrontmatter(content);
      // Quotes stay in name/description since we don't strip them there,
      // but tags should have quotes stripped
      assert.deepEqual(result.tags, ['tag1', 'tag2']);
    });
  });

  describe('parseSkillsSearchOutput', () => {
    it('parses clean search results', () => {
      const output = [
        'SKILLS',
        '',
        'Install with npx skills add <owner/repo@skill>',
        '',
        'vercel-labs/agent-skills@vercel-react-best-practices  176K installs',
        '  https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices',
        '',
        'millionco/react-doctor@react-doctor  5.1K installs',
        '  https://skills.sh/millionco/react-doctor/react-doctor',
      ].join('\n');

      const results = parseSkillsSearchOutput(output);
      assert.equal(results.length, 2);
      assert.equal(results[0].package, 'vercel-labs/agent-skills@vercel-react-best-practices');
      assert.equal(results[0].name, 'vercel-react-best-practices');
      assert.equal(results[0].installs, '176K');
      assert.ok(results[0].url.includes('skills.sh'));
      assert.equal(results[1].package, 'millionco/react-doctor@react-doctor');
      assert.equal(results[1].installs, '5.1K');
    });

    it('returns empty array for no results', () => {
      const output = 'No skills found for query "xyznotexist".';
      const results = parseSkillsSearchOutput(output);
      assert.equal(results.length, 0);
    });

    it('strips ANSI codes before parsing', () => {
      const output = '\x1b[36mvercel-labs/agent-skills@react\x1b[0m  10K installs\n  https://skills.sh/vercel-labs/agent-skills/react';
      const results = parseSkillsSearchOutput(output);
      assert.equal(results.length, 1);
      assert.equal(results[0].package, 'vercel-labs/agent-skills@react');
    });

    it('handles results without URLs', () => {
      const output = 'owner/repo@skill  42K installs\n\n';
      const results = parseSkillsSearchOutput(output);
      assert.equal(results.length, 1);
      assert.equal(results[0].url, '');
    });
  });

  describe('input validation', () => {
    it('rejects path traversal in skill names', () => {
      assert.ok(!/^[a-zA-Z0-9_.-]+$/.test('../etc/passwd'));
      assert.ok(!/^[a-zA-Z0-9_.-]+$/.test('skill/subdir'));
      assert.ok(!/^[a-zA-Z0-9_.-]+$/.test('skill name'));
    });

    it('accepts valid skill names', () => {
      assert.ok(/^[a-zA-Z0-9_.-]+$/.test('security-review'));
      assert.ok(/^[a-zA-Z0-9_.-]+$/.test('ros2-robotics'));
      assert.ok(/^[a-zA-Z0-9_.-]+$/.test('find-skills'));
      assert.ok(/^[a-zA-Z0-9_.-]+$/.test('remotion-best-practices'));
    });

    it('rejects invalid package identifiers', () => {
      const pkgRegex = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+@[a-zA-Z0-9_:.-]+$/;
      assert.ok(!pkgRegex.test('not-valid'));
      assert.ok(!pkgRegex.test('../bad/path@skill'));
      assert.ok(!pkgRegex.test(''));
      assert.ok(!pkgRegex.test('owner/repo'));
    });

    it('accepts valid package identifiers', () => {
      const pkgRegex = /^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+@[a-zA-Z0-9_:.-]+$/;
      assert.ok(pkgRegex.test('vercel-labs/agent-skills@vercel-react-best-practices'));
      assert.ok(pkgRegex.test('google-labs-code/stitch-skills@react:components'));
      assert.ok(pkgRegex.test('owner/repo@skill-name'));
    });

    it('rejects invalid search queries', () => {
      assert.ok(!/^[a-zA-Z0-9\s._-]+$/.test('query;rm -rf'));
      assert.ok(!/^[a-zA-Z0-9\s._-]+$/.test('query$(whoami)'));
      assert.ok(!/^[a-zA-Z0-9\s._-]+$/.test(''));
    });

    it('accepts valid search queries', () => {
      assert.ok(/^[a-zA-Z0-9\s._-]+$/.test('react'));
      assert.ok(/^[a-zA-Z0-9\s._-]+$/.test('react native'));
      assert.ok(/^[a-zA-Z0-9\s._-]+$/.test('best-practices'));
      assert.ok(/^[a-zA-Z0-9\s._-]+$/.test('ros2.robotics'));
    });
  });
});

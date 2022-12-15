module.exports = {
  extends: ['@commitlint/config-lerna-scopes', '@commitlint/config-conventional'],
  rules: {
    'type-enum': [0, 'always', ['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'revert', 'breaking', 'ops']],
  },
};

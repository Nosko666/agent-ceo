const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const TagManager = require('../src/tags');
const SessionManager = require('../src/session');

describe('TagManager', () => {
  let session;
  let tags;

  beforeEach(() => {
    session = new SessionManager();
    tags = new TagManager(session);
  });

  test('extractTags finds #tags in text', () => {
    const result = tags.extractTags('This is a #decision about #auth');
    assert.deepStrictEqual(result, ['decision', 'auth']);
  });

  test('extractTags returns empty for no tags', () => {
    assert.deepStrictEqual(tags.extractTags('no tags here'), []);
  });

  test('extractSuggestions finds [suggest: #tag]', () => {
    const suggestions = tags.extractSuggestions('claude1', 'I think [suggest: #bug] this needs fixing');
    assert.strictEqual(suggestions.length, 1);
    assert.strictEqual(suggestions[0].tag, 'bug');
    assert.strictEqual(suggestions[0].agentName, 'claude1');
  });

  test('peekPendingSuggestions does not clear', () => {
    tags.addSuggestion({ agentName: 'claude1', tag: 'bug', text: 'test', timestamp: new Date().toISOString() });
    const first = tags.peekPendingSuggestions();
    const second = tags.peekPendingSuggestions();
    assert.strictEqual(first.length, 1);
    assert.strictEqual(second.length, 1);
  });

  test('confirmSuggestion removes from pending and adds to session', () => {
    tags.addSuggestion({ agentName: 'claude1', tag: 'bug', text: 'test', timestamp: new Date().toISOString() });
    const confirmed = tags.confirmSuggestion(0);
    assert.strictEqual(confirmed.tag, 'bug');
    assert.strictEqual(tags.peekPendingSuggestions().length, 0);
    assert.strictEqual(session.tags.length, 1);
  });

  test('dismissSuggestion removes without adding to session', () => {
    tags.addSuggestion({ agentName: 'claude1', tag: 'bug', text: 'test', timestamp: new Date().toISOString() });
    const dismissed = tags.dismissSuggestion(0);
    assert.strictEqual(dismissed.tag, 'bug');
    assert.strictEqual(session.tags.length, 0);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanVoiceTranscript } from '../src/voiceTranscript.mjs';

test('voice transcript cleanup removes filler words and repeated stutter phrases', () => {
  assert.equal(
    cleanVoiceTranscript('Um, what is what is what is the distribution uh of the outcome?'),
    'what is the distribution of the outcome?'
  );
});

test('voice transcript cleanup preserves meaningful words and punctuation', () => {
  assert.equal(
    cleanVoiceTranscript('The study, study? Examines risk—risk over time.'),
    'The study? Examines risk—over time.'
  );
});

const FILLER_WORDS = new Set(['um', 'uh', 'er', 'erm', 'hmm', 'mm', 'mm-hm']);

function comparisonToken(token) {
  return String(token || '').toLocaleLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

function removeRepeatedWordInsideToken(token) {
  return String(token || '').replace(/(\p{L}[\p{L}\p{N}]*)([—–-])\1(?=$|[^\p{L}\p{N}])/giu, '$1$2');
}

function tidyPunctuation(value) {
  return String(value || '')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/([,.!?;:]){2,}/g, '$1')
    .replace(/([—–-])\s+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function cleanVoiceTranscript(value) {
  const raw = tidyPunctuation(String(value || '').replace(/\s+/g, ' ').trim());
  if (!raw) return '';
  const tokens = raw
    .split(' ')
    .map(removeRepeatedWordInsideToken)
    .filter(token => token && !FILLER_WORDS.has(comparisonToken(token)));
  const output = [];
  for (let index = 0; index < tokens.length;) {
    let repeated = false;
    for (let size = Math.min(4, output.length, tokens.length - index); size >= 1; size -= 1) {
      const prior = output.slice(-size).map(comparisonToken);
      const next = tokens.slice(index, index + size).map(comparisonToken);
      if (prior.length === size && next.length === size && prior.every((token, offset) => token && token === next[offset])) {
        if (size === 1 && output.length) {
          const punctuation = String(tokens[index]).match(/[!?.,;:]+$/)?.[0];
          if (punctuation) output[output.length - 1] = `${String(output[output.length - 1]).replace(/[!?.,;:]+$/, '')}${punctuation}`;
        }
        index += size;
        repeated = true;
        break;
      }
    }
    if (!repeated) output.push(tokens[index++]);
  }
  return tidyPunctuation(output.join(' '));
}

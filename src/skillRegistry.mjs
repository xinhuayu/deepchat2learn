import fs from 'node:fs';
import path from 'node:path';

const MAX_SKILL_FILE_BYTES = 120_000;
const MAX_REFERENCE_FILE_BYTES = 240_000;

function readBounded(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) throw new Error('Skill file is missing, empty, or too large.');
  return fs.readFileSync(filePath, 'utf8');
}

function parseFrontmatter(markdown) {
  const match = String(markdown).match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) throw new Error('Skill frontmatter is required.');
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    metadata[key] = value;
  }
  return { metadata, content: markdown.slice(match[0].length).trim() };
}

function loadProfile(profileDir, id) {
  const skillPath = path.join(profileDir, 'SKILL.md');
  const { metadata, content } = parseFrontmatter(readBounded(skillPath, MAX_SKILL_FILE_BYTES));
  if (metadata.name !== id || !metadata.description || !content) throw new Error('Skill metadata is incomplete.');
  const references = {};
  const referencesDir = path.join(profileDir, 'references');
  if (fs.existsSync(referencesDir)) {
    for (const entry of fs.readdirSync(referencesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      references[entry.name] = readBounded(path.join(referencesDir, entry.name), MAX_REFERENCE_FILE_BYTES).trim();
    }
  }
  return Object.freeze({
    id,
    name: metadata.name,
    description: metadata.description,
    instructions: content,
    references: Object.freeze(references)
  });
}

function publicSkill(profile) {
  if (!profile) return null;
  return { id: profile.id, name: profile.name, description: profile.description };
}

export function loadSkillRegistry({ rootDir = process.cwd() } = {}) {
  const skillsDir = path.join(rootDir, 'skills');
  const profiles = new Map();
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]*$/.test(entry.name)) continue;
      try {
        profiles.set(entry.name, loadProfile(path.join(skillsDir, entry.name), entry.name));
      } catch {
        // Invalid optional profiles are ignored so general source discussion remains available.
      }
    }
  }

  return Object.freeze({
    get(id) {
      return profiles.get(String(id || '')) || null;
    },
    list() {
      return [...profiles.values()].map(publicSkill);
    },
    promptContext(id) {
      const profile = profiles.get(String(id || ''));
      if (!profile) return '';
      const references = Object.entries(profile.references)
        .map(([name, text]) => `\n\nReference guidance: ${name}\n${text}`)
        .join('');
      return `Skill guidance: ${profile.name}\n${profile.instructions}${references}`;
    }
  });
}

import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const testFiles = (await readdir(path.join(process.cwd(), 'tests')))
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => path.join('tests', name));

const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...testFiles], {
  cwd: process.cwd(),
  env: { ...process.env, DEEPCHAT2LEARN_SKIP_DOTENV: '1' },
  stdio: 'inherit'
});

child.on('error', error => {
  console.error(`Unable to start the test runner: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', code => {
  process.exitCode = code ?? 1;
});

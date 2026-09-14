import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `.sandcastle/worktrees/**` is a checkout a running agent is editing, and
    // linting it makes this command fail on somebody else's half-written file:
    // `npm run lint` reported two unused-variable errors in a live run's
    // `VgaMachine.ts` while this tree was clean. A gate that fails for reasons
    // outside the tree it is gating is a gate people learn to ignore.
    ignores: [
      'dist/**',
      'dist-web/**',
      'coverage/**',
      'node_modules/**',
      'public/**',
      '.sandcastle/worktrees/**',
      '.scratch/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The engine mirrors a C++ codebase full of bit twiddling; these are noise there.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-bitwise': 'off',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // One script engine per SCUMM version (ADR 0001), each in its own directory
    // under `script/` (ADR 0003). A version must never import another version:
    // the shared parts belong in `script/`, and anything a sibling has that you
    // want is either shared state or a coincidence of that version's encoding.
    //
    // Matched by directory name rather than by depth: `*` in a minimatch
    // pattern happily matches `..`, so a depth-counting pattern like `../*/*`
    // also catches `../../ScummEngine.js`, which is a legitimate import. Naming
    // the `v<n>` convention is both narrower and easier to read, and still
    // version-agnostic — a v7 directory is covered the day it appears.
    files: ['src/engine/script/*/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../v*/**', '../../script/v*/**'],
              message:
                'A script engine must not import another version. Shared code belongs in src/engine/script/, not in a sibling version directory.',
            },
          ],
        },
      ],
    },
  },
  {
    // AGI is a second Engine family, not a third SCUMM version (ADR 0011), so
    // the boundary it needs is a different one: not "do not import a sibling
    // version" but "do not import SCUMM's script machinery at all".
    //
    // The four modules below are the ones it would be tempting to reach for and
    // the ones that would be wrong. StackScriptEngine is the stack machine v6
    // and v7 share (ADR 0006) and AGI is not a stack machine; ScriptScheduler,
    // ScriptSlot and ScriptState are SCUMM's slot model and cutscene stack, and
    // AGI has neither — its whole state is 255 flags and 255 vars (#129).
    //
    // Enforced rather than documented because the failure is not a build error:
    // importing one of these would work, and would quietly make the AGI engine
    // depend on SCUMM's shape.
    files: ['src/engine/agi/**/*.ts', 'src/authoring/agi/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/script/StackScriptEngine*',
                '**/script/ScriptScheduler*',
                '**/script/ScriptSlot*',
                '**/script/ScriptState*',
                '**/script/v*/**',
                '**/ScummEngine*',
              ],
              message:
                'AGI must not import SCUMM script machinery. It is not a stack machine, it has no script slots and no cutscene stack — its whole state is 255 flags and 255 vars (ADR 0011, ADR 0012, #129).',
            },
          ],
        },
      ],
    },
  },
);

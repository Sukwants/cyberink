import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
export default tseslint.config(
 { ignores: ['dist/**', 'node_modules/**', 'data/**', '.test-data/**'] },
 js.configs.recommended, ...tseslint.configs.recommended,
 { files: ['**/*.ts'], languageOptions: { globals: globals.node }, rules: { '@typescript-eslint/no-explicit-any': 'off' } },
 { files: ['public/**/*.js'], languageOptions: { globals: globals.browser } }
);

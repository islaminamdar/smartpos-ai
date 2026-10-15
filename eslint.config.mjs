import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { FlatCompat } from '@eslint/eslintrc'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const compat = new FlatCompat({
  baseDirectory: __dirname,
})

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    // Existing legacy integrations predate the POS. Keep their loose typing
    // visible as warnings while the public-release gate makes them unreachable.
    // New POS modules and routes retain the recommended error-level rule.
    files: [
      'app/(app)/**', 'app/api/print/**', 'app/api/stripe/**',
      'components/dashboard/**', 'components/kds/**', 'components/order/**',
      'lib/ai/**', 'lib/billing/**', 'lib/db/**', 'lib/realtime/**',
    ],
    rules: { '@typescript-eslint/no-explicit-any': 'warn' },
  },
]

export default eslintConfig

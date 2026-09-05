// test/setup.ts — runs before every unit test file.
//
// jest-dom adds matchers like toBeInTheDocument and toBeDisabled, which read
// as English rather than as DOM property checks. cleanup unmounts what a
// test rendered so the next one starts with an empty document.

import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
})

import { test, expect } from '@playwright/test'

// Enable when Supabase + .env.local provisioned; assumes a seeded tenant + menu.
test.skip('text-input parse produces a KDS ticket', async ({ page, request }) => {
  const res = await request.post('/api/ai/parse-order', {
    data: { kind: 'text', text: 'two karak less sugar', locale: 'en' },
  })
  expect(res.ok()).toBeTruthy()
  await page.goto('/kds')
  await expect(page.getByText('Karak')).toBeVisible({ timeout: 5000 })
})

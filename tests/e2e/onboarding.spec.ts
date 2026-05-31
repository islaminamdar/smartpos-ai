import { test, expect } from '@playwright/test'

// Enable when Supabase + .env.local provisioned and a real auth account exists.
test.skip('signup redirects to onboarding then dashboard', async ({ page }) => {
  const email = `e2e+${Date.now()}@smartpos.test`
  await page.goto('/signup')
  await page.fill('input[name=fullName]', 'E2E')
  await page.fill('input[name=restaurantName]', 'E2E Café')
  await page.fill('input[name=email]', email)
  await page.fill('input[name=password]', 'password123')
  await page.click('button[type=submit]')
  await expect(page).toHaveURL(/\/onboarding/)
  await page.click('text=manually')
  await page.click('text=Skip for now')
  await page.click('text=Skip')
  await expect(page.getByText("You're live")).toBeVisible()
})

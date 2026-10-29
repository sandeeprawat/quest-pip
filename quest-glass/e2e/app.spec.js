import { test, expect } from '@playwright/test';

test('desktop preview places, grabs, drinks, and refills a cup', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#viewport canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Try desktop demo' }).click();
  const canvas = page.locator('#viewport canvas');
  const bounds = await canvas.boundingBox();
  await canvas.click({ position: { x: bounds.width * 0.5, y: bounds.height * 0.65 } });
  await expect(page.locator('#status')).toHaveText('Click the cup to grab it, then hold S to simulate a sip.');
  await canvas.click({ position: { x: bounds.width * 0.5, y: bounds.height * 0.59 } });
  await expect(page.locator('#status')).toContainText('Holding virtual cup');
  await page.keyboard.down('s');
  await expect(page.locator('#status')).toContainText('Sipping!');
  await expect.poll(async () => parseInt(await page.locator('#remaining').innerText(), 10)).toBeLessThan(90);
  await page.keyboard.up('s');
  await expect(page.locator('#status')).toContainText('Sip finished');
  await canvas.click();
  await page.getByRole('button', { name: 'Refill & reset' }).click();
  await expect(page.locator('#remaining')).toHaveText('100%');
  await expect(page.locator('#error')).toBeHidden();
  expect(errors).toEqual([]);
});

test('landing page fits a mobile viewport and reports unsupported XR', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('#viewport canvas')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await expect(page.locator('#enter-xr')).toBeDisabled();
  await expect(page.locator('#error')).toBeHidden();
});

test('denied immersive access displays an actionable error and allows retry', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'xr', {
      configurable: true,
      value: {
        isSessionSupported: async () => true,
        requestSession: async () => { throw new Error('Permission denied'); },
      },
    });
  });
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Enter mixed reality' });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.locator('#error')).toContainText('Permission denied');
  await expect(button).toBeEnabled();
});

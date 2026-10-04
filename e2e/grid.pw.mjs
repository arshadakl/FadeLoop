import { test, expect } from '@playwright/test';
for (const theme of ['light', 'dark']) for (const width of [320, 375, 390, 768, 1440]) {
  test(`grid ${theme} ${width}: switching, selection, search, persistence and keyboard editing`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.route('**/api/media', route => route.fulfill({ json: { media: [] } }));
    await page.route('**/api/campaigns', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const data = await response.json();
      const sample = data.campaigns.find(c => c.campaign_id === 'sample');
      await route.fulfill({ json: { campaigns: Array.from({ length: 3 }, (_, index) => ({ ...sample, campaign_id: index ? `grid-${index}` : 'sample', name: `Grid automation ${index + 1}` })) } });
    });
    await page.goto('/');
    await page.getByLabel('Email address').fill('owner@example.com');
    await page.getByLabel('Password', { exact: true }).fill('mobile test password with spaces');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Grid automation 1', exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: 'Select Grid automation 1', exact: true }).check();
    await page.getByRole('button', { name: 'View as grid', exact: true }).click();
    await expect(page.getByRole('button', { name: 'View as list', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('checkbox', { name: 'Select Grid automation 1', exact: true })).toBeChecked();
    await expect(page.getByRole('button', { name: 'Archive selected', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Move selected', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (width === 320 || width === 1440) await page.screenshot({ path: `test-results/grid-${theme}-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: 'View as list', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: 'Select Grid automation 1', exact: true })).toBeChecked();
    await page.getByRole('button', { name: 'View as grid', exact: true }).click();
    await page.getByLabel('Search automations').fill('does not exist');
    await expect(page.getByText('No automations match your search.')).toBeVisible();
    await page.getByLabel('Search automations').fill('');
    await page.reload();
    await expect(page.getByRole('button', { name: 'View as list', exact: true })).toBeVisible();
    const card = page.getByRole('group', { name: 'Grid automation 1', exact: true });
    await card.focus();
    await card.press('Enter');
    await expect(page.getByLabel('Automation name')).toHaveValue('Grid automation 1');
  });
}

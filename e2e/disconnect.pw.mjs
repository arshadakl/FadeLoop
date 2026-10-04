import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

for (const theme of ['light', 'dark']) for (const width of [320, 390, 768, 1440]) {
  test(`disconnect ${theme} ${width}: confirmation, cancellation, errors and workspace reset`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    let reset = false, attempts = 0, unknown = false, checkFails = false;
    await page.route('**/api/status', async route => {
      if (checkFails) { checkFails = false; return route.abort(); }
      await route.fulfill({ json: { connected: !reset, token_expired: true, username: 'creator_studio', connection_generation: reset ? 1 : 0 } });
    });
    await page.route('**/api/campaigns', route => reset ? route.fulfill({ json: { campaigns: [] } }) : route.continue());
    await page.route('**/api/folders', route => reset ? route.fulfill({ json: { folders: [] } }) : route.continue());
    await page.route('**/auth/disconnect', async route => {
      attempts++;
      const body = route.request().postDataJSON();
      expect(body.connection_generation).toBe(0);
      if (body.password === 'wrong-password') return route.fulfill({ status: 403, json: { error: 'Incorrect FadeLoop login password.' } });
      if (unknown) { unknown = false; checkFails = true; return route.abort(); }
      reset = true;
      await route.fulfill({ json: { disconnected: true, deleted: true } });
    });
    await page.goto('/');
    await page.getByLabel('Email address').fill('owner@example.com');
    await page.getByLabel('Password', { exact: true }).fill('mobile test password with spaces');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'New automation', exact: true }).click();
    await page.getByLabel('Automation name').fill('Preserve this unsaved draft');
    await page.getByRole('button', { name: /^(Open account menu|Account & appearance)$/ }).click();
    await page.getByRole('button', { name: 'Disconnect Instagram', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Disconnect Instagram @creator_studio', exact: true });
    const input = dialog.getByLabel('FadeLoop login password');
    const submit = dialog.getByRole('button', { name: 'Disconnect and delete everything', exact: true });
    await expect(dialog).toContainText('Your unsaved builder changes will also be discarded.');
    await expect(input).toHaveAttribute('autocomplete', 'current-password');
    await input.fill('secret-to-clear');
    await dialog.getByRole('button', { name: 'Show password', exact: true }).click();
    await expect(input).toHaveAttribute('type', 'text');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Disconnect Instagram', exact: true }).click();
    await expect(input).toHaveValue('');
    await input.fill('also-clear-on-escape');
    await input.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Disconnect Instagram', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Disconnect Instagram', exact: true }).press('Enter');
    await expect(input).toHaveValue('');
    await input.fill('wrong-password');
    await submit.click();
    await expect(dialog.getByRole('alert')).toContainText('Incorrect FadeLoop login password');
    await expect(input).toHaveValue('');
    expect(attempts).toBe(1);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Close menu', exact: true }).click();
    await expect(page.getByLabel('Automation name')).toHaveValue('Preserve this unsaved draft');
    await page.getByRole('button', { name: /^(Open account menu|Account & appearance)$/ }).click();
    await page.getByRole('button', { name: 'Disconnect Instagram', exact: true }).click();
    await input.fill('correct-password');
    unknown = true;
    await submit.click();
    await expect(dialog.getByRole('alert')).toContainText('Unable to confirm the outcome');
    await expect(submit).toBeDisabled();
    expect(attempts).toBe(2); // The destructive POST is never retried automatically.
    await dialog.getByRole('button', { name: 'Check connection status', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('workspace is still connected');
    await input.fill('correct-password');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const violations = (await new AxeBuilder({ page }).include('.disconnect-dialog').analyze()).violations;
    expect(violations).toEqual([]);
    for (const button of await dialog.getByRole('button').all()) {
      const bounds = await button.boundingBox();
      expect(bounds?.height).toBeGreaterThanOrEqual(44);
    }
    await submit.click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'All workspace automation data was deleted' })).toBeVisible();
    await expect(page).toHaveURL(/#automations$/);
    await expect(page.getByLabel('Email address')).toHaveCount(0);
    await expect(page.getByRole('group')).toHaveCount(0);
    expect(attempts).toBe(3);
  });
}

test('disconnect uncertain committed response refreshes status without another destructive request', async ({ page }) => {
  let disconnected = false, attempts = 0;
  await page.route('**/api/status', route => route.fulfill({ json: { connected: !disconnected, connection_generation: disconnected ? 1 : 0, username: 'creator_studio', token_expired: true } }));
  await page.route('**/api/campaigns', route => disconnected ? route.fulfill({ json: { campaigns: [] } }) : route.continue());
  await page.route('**/api/folders', route => disconnected ? route.fulfill({ json: { folders: [] } }) : route.continue());
  await page.route('**/auth/disconnect', route => { attempts++; disconnected = true; return route.abort(); });
  await page.goto('/');
  await page.getByLabel('Email address').fill('owner@example.com');
  await page.getByLabel('Password', { exact: true }).fill('mobile test password with spaces');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: /^(Open account menu|Account & appearance)$/ }).click();
  await page.getByRole('button', { name: 'Disconnect Instagram', exact: true }).click();
  await page.getByLabel('FadeLoop login password').fill('correct-password');
  await page.getByRole('button', { name: 'Disconnect and delete everything', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'All workspace automation data was deleted' })).toBeVisible();
  expect(attempts).toBe(1);
});

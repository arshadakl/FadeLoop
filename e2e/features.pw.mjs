import { test, expect } from '@playwright/test';
const password = 'mobile test password with spaces';
async function signIn(page) {
  await page.route('**/api/media', route => route.fulfill({ json: { media: [{ id: 'media1', caption: 'Creator guide', media_type: 'IMAGE' }] } }));
  await page.goto('/');
  await page.getByLabel('Email address').fill('owner@example.com');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New automation', exact: true })).toBeVisible();
}
async function choose(page, name, option) {
  await page.getByRole('combobox', { name, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
for (const theme of ['light', 'dark']) for (const width of [320, 390, 768, 1440]) {
  test(`features ${theme} ${width}: folder management and any-comment drafts`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await signIn(page);
    await page.getByRole('button', { name: 'New folder', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const name = `Guides ${theme} ${width}`;
    await dialog.getByLabel('Folder name').fill(name);
    await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.getByRole('button', { name: `Actions for folder ${name}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await dialog.getByLabel('Folder name').fill(`${name} renamed`);
    await dialog.getByRole('button', { name: 'Save folder name', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: `Open folder ${name} renamed`, exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: 'Select Creator guide — comment to get the free resource', exact: true }).check();
    await choose(page, 'Move selected to folder', `${name} renamed`);
    await page.getByRole('button', { name: 'Move selected', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Automations moved' })).toBeVisible();
    await expect(page.getByText('No unfiled automations. Open a folder to see its automations.')).toBeVisible();
    await page.getByRole('button', { name: `Open folder ${name} renamed`, exact: true }).click();
    await page.getByRole('group').first().click();
    await expect(page.getByRole('combobox', { name: 'Automation folder', exact: true })).toContainText(`${name} renamed`);
    await choose(page, 'Comment matching', 'Any comment');
    await expect(page.getByLabel('Keywords (comma separated)')).toHaveCount(0);
    await page.getByLabel('Exclude words (optional)').fill('fake, scam');
    await choose(page, 'Comment matching', 'A specific word or words');
    await expect(page.getByLabel('Keywords (comma separated)')).toHaveValue('GUIDE');
    await choose(page, 'Comment matching', 'Any comment');
    const saved = page.waitForRequest(r => r.url().endsWith('/api/campaigns') && r.method() === 'POST');
    await page.getByRole('button', { name: /^Save/ }).click();
    const payload = (await saved).postDataJSON();
    expect(payload.campaign.match_mode).toBe('any');
    expect(payload.campaign.exclude).toEqual(['fake', 'scam']);
    expect(payload.folder_id).toBeTruthy();
    await expect(page.getByRole('status')).toContainText('Saved');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expect(page.getByText('Any post or reel', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Like their comment', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Follow-up DM if they don’t click', { exact: true })).toHaveCount(0);
    // Restore the shared fixture's original trigger for subsequent tests.
    await choose(page, 'Comment matching', 'A specific word or words');
    const restored = page.waitForResponse(r => r.url().endsWith('/api/campaigns') && r.request().method() === 'POST');
    await page.getByRole('button', { name: /^Save/ }).click();
    expect((await restored).status()).toBe(200);
    await expect(page.getByRole('button', { name: /^Save/ })).toBeEnabled();
    await expect(page.getByRole('status')).toContainText('Saved');
    await page.getByRole('button', { name: 'Automations', exact: true }).filter({ visible: true }).first().click();
    await page.getByRole('button', { name: 'Back to Automations', exact: true }).click();
    await page.getByRole('button', { name: `Actions for folder ${name} renamed`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete folder', exact: true }).click();
    await dialog.getByRole('button', { name: 'Delete folder', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: `Open folder ${name} renamed`, exact: true })).toHaveCount(0);
    await expect(page.getByRole('group')).toBeVisible();
  });
}
test('features password settings retain this device, clear failed fields, and preserve unsaved drafts', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 850 });
  await signIn(page);
  await page.getByRole('button', { name: 'New automation', exact: true }).click();
  await page.getByLabel('Automation name').fill('Unsaved draft');
  await page.getByRole('button', { name: 'Open account menu', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('New password', { exact: true }).fill('changed123');
  await dialog.getByLabel('Confirm new password', { exact: true }).fill('mismatch');
  await dialog.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Passwords do not match');
  await expect(dialog.getByLabel('New password', { exact: true })).toHaveValue('');
  await dialog.getByLabel('New password', { exact: true }).fill('changed123');
  await dialog.getByLabel('Confirm new password', { exact: true }).fill('changed123');
  await dialog.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Password changed');
  await expect(dialog.getByLabel('New password', { exact: true })).toHaveValue('');
  await dialog.getByRole('button', { name: 'Close menu', exact: true }).click();
  await expect(page.getByLabel('Automation name')).toHaveValue('Unsaved draft');
  // Restore fixture credentials before the remaining suite runs.
  await page.getByRole('button', { name: 'Open account menu', exact: true }).click();
  await dialog.getByLabel('New password', { exact: true }).fill(password);
  await dialog.getByLabel('Confirm new password', { exact: true }).fill(password);
  await dialog.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('Password changed');
});

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function signIn(page) {
  await page.route('**/api/media', route => route.fulfill({ json: { media: [] } }));
  await page.goto('/');
  await page.getByLabel('Email address').fill('owner@example.com');
  await page.getByLabel('Password', { exact: true }).fill('mobile test password with spaces');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New automation', exact: true })).toBeVisible();
}
async function mutation(page, path, body) {
  const result = await page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, { path, body });
  expect(result.status).toBe(200);
  return result.body;
}
async function refresh(page) { await page.reload(); await expect(page.getByRole('heading', { name: 'My automations', exact: true })).toBeVisible(); }
for (const theme of ['light', 'dark']) for (const width of [320, 375, 390, 768, 1440]) {
  test(`drive folders ${theme} ${width}: opening, history, search, menus and branding`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await signIn(page);
    const name = `Creator resources ${theme} ${width}`;
    const folder = await mutation(page, '/api/folders', { name });
    const empty = await mutation(page, '/api/folders', { name: `Empty folder ${theme} ${width}` });
    await mutation(page, '/api/folders/move', { folder_id: folder.folder_id, campaign_ids: ['sample'] });
    await refresh(page);
    await expect(page.getByRole('group')).toHaveCount(0);
    const tile = page.getByRole('button', { name: `Open folder ${name}`, exact: true });
    await expect(tile).toContainText('1 automation');
    await expect(page.getByRole('link', { name: 'FadeLoop home', exact: true }).filter({ visible: true }).locator('img')).toHaveAttribute('src', '/logo.svg');
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check('700 21px Outfit'))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (width === 320 || width === 1440) await page.screenshot({ path: `test-results/drive-${theme}-${width}-root.png`, fullPage: true });
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(audit.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.failureSummary) }))).toEqual([]);
    // Search root folder names, then opening clears the previous location's query.
    await page.getByLabel('Search automations').fill('Creator resources');
    await tile.click();
    await expect(page).toHaveURL(new RegExp(`#automations/folder/${folder.folder_id}$`));
    await expect(page.getByRole('group')).toHaveCount(1);
    await expect(page.getByLabel('Search automations')).toHaveValue('');
    await page.goBack();
    await expect(page).toHaveURL(/#automations$/);
    await page.goForward();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Back to Automations', exact: true }).click();
    await page.getByRole('button', { name: `Open folder Empty folder ${theme} ${width}`, exact: true }).click();
    await expect(page.getByText('This folder is empty. Create an automation here or move one into this folder.')).toBeVisible();
    await page.getByRole('button', { name: 'Back to Automations', exact: true }).click();
    await tile.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Folder name')).toHaveValue(name);
    await expect(dialog.getByLabel('Folder name')).toBeFocused();
    await page.route('**/api/folders/rename', route => route.fulfill({ status: 409, json: { error: 'A folder with that name already exists' } }));
    await dialog.getByLabel('Folder name').fill('Duplicate');
    await dialog.getByRole('button', { name: 'Save folder name', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('already exists');
    await expect(dialog.getByLabel('Folder name')).toHaveValue('Duplicate');
    await page.unroute('**/api/folders/rename');
    await dialog.getByLabel('Folder name').fill(`${name} renamed`);
    await dialog.getByRole('button', { name: 'Save folder name', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const renamed = page.getByRole('button', { name: `Open folder ${name} renamed`, exact: true });
    await renamed.focus(); await renamed.press('Shift+F10');
    await expect(page.getByRole('menuitem', { name: 'Open', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: `Actions for folder ${name} renamed`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete folder', exact: true }).click();
    await dialog.getByRole('button', { name: 'Delete folder', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('group')).toHaveCount(1);
    await mutation(page, '/api/folders/delete', { folder_id: empty.folder_id });
    // All static entries use the same SVG and raster fallback assets.
    for (const path of ['/', '/privacy', '/terms', '/data-deletion']) {
      await page.goto(path);
      await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute('href', '/logo.svg');
      await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/apple-touch-icon.png');
      await expect(page.getByRole('link', { name: 'FadeLoop home', exact: true }).filter({ visible: true })).toBeVisible();
    }
  });
}
test('drive folders: missing/deleted locations and unsaved browser history preserve drafts', async ({ page }) => {
  await signIn(page);
  const folder = await mutation(page, '/api/folders', { name: 'History test' });
  await mutation(page, '/api/folders/move', { folder_id: folder.folder_id, campaign_ids: ['sample'] });
  await refresh(page);
  await page.getByRole('button', { name: 'Open folder History test', exact: true }).click();
  await page.getByLabel('Search automations').fill('Creator');
  await page.getByRole('group').first().click();
  await page.getByLabel('Automation name').fill('Unsaved history draft');
  page.once('dialog', dialog => dialog.dismiss());
  await page.goBack();
  await expect(page).toHaveURL(/#create$/);
  await expect(page.getByLabel('Automation name')).toHaveValue('Unsaved history draft');
  page.once('dialog', dialog => dialog.accept());
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`#automations/folder/${folder.folder_id}$`));
  await expect(page.getByLabel('Search automations')).toHaveValue('Creator');
  await mutation(page, '/api/folders/delete', { folder_id: folder.folder_id });
  await page.reload();
  await expect(page).toHaveURL(/#automations$/);
  await expect(page.getByRole('alert')).toContainText('no longer available');
  await page.goto('/#automations/folder/missing');
  await expect(page).toHaveURL(/#automations$/);
  await expect(page.getByRole('alert')).toContainText('no longer available');
});

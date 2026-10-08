import { test } from '@playwright/test';

test('captura de bienvenida (smoke)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
  });
  await page.goto('/?mock=1&quality=low&lang=es');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: '../../.scratch/world/smoke-welcome.png' });
  console.log(errors.join('\n'));
});

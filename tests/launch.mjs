import { _electron } from 'playwright-core';
import electronPath from 'electron';
import { fileURLToPath } from 'node:url';

export async function launchDesktop(directory) {
  const env = { ...process.env, KANBAN_DATA_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({
    executablePath: electronPath, args: [fileURLToPath(new URL('../', import.meta.url))], env, timeout: 30_000,
  });
  try {
    const page = await application.firstWindow({ timeout: 20_000 });
    await page.waitForFunction(() => !!window.kanban);
    return { application, page };
  } catch (error) {
    await application.close();
    throw error;
  }
}

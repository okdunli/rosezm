import * as fs from 'node:fs';
import * as path from 'node:path';
import { appIdentity } from './app-identity.js';

export const THEME_BRIDGE_FILE = 'rosezm-theme.js';
const THEME_BRIDGE_TAG = '<script src="/rosezm-theme.js"></script>';

/** The status bar follows the system: the official plugin cannot listen
 *  for the theme change itself, so the shell ships a listener that flips
 *  the style between the two declared values. Written only when the app
 *  declares a dark variant at all. */
export async function injectThemeBridge(site: string, projectRoot: string): Promise<number> {
  const app = appIdentity(projectRoot);
  if (!app.statusBar?.styleDark) return 0;
  const light = app.statusBar.style ?? 'dark';
  const dark = app.statusBar.styleDark;
  const script = [
    '// rosezm: the status bar follows the system theme (rosezm.app.json statusBar).',
    '(function () {',
    '  const cap = window.Capacitor;',
    '  if (!cap || !cap.Plugins || !cap.Plugins.StatusBar) return;',
    '  const apply = function (dark) {',
    `    cap.Plugins.StatusBar.setStyle({ style: dark ? ${JSON.stringify(dark === 'dark' ? 'Dark' : 'Light')} : ${JSON.stringify(light === 'dark' ? 'Dark' : 'Light')} });`,
    '  };',
    '  const mq = window.matchMedia(\'(prefers-color-scheme: dark)\');',
    '  apply(mq.matches);',
    "  mq.addEventListener ? mq.addEventListener('change', function (e) { apply(e.matches); }) : mq.addListener(function (e) { apply(e.matches); });",
    '})();',
  ].join('\n');
  await fs.promises.writeFile(path.join(site, THEME_BRIDGE_FILE), script, 'utf8');
  let tagged = 0;
  const walk = async (dir: string) => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(p); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const html = await fs.promises.readFile(p, 'utf8');
      if (html.includes(THEME_BRIDGE_FILE)) continue;
      const next = html.includes('</head>')
        ? html.replace('</head>', THEME_BRIDGE_TAG + '</head>')
        : THEME_BRIDGE_TAG + html;
      await fs.promises.writeFile(p, next, 'utf8');
      tagged++;
    }
  };
  await walk(site);
  return tagged;
}
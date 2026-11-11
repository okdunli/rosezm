/**
 * rosezm - cold-boot splash (desktop shells).
 *
 * A client-rendered document paints nothing until its bundle has run; on a
 * cold start that is a blank window for a second or more. This paints a tiny
 * icon-bounce plate the instant <body> is parsed (pure CSS, no JS needed to
 * show it) and fades it out on the page's own `rosezm:first-frame` event, so
 * the user never sees an empty frame. A safety timer hides it anyway.
 *
 * The icon is optional: pass an image URL (the app logo) or fall back to the
 * app's first letter on a rounded tile.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const BOOT_SPLASH_MARKER = 'rosezm-boot-splash';

function splashHtml(letter: string, logo?: string): string {
  const icon = logo
    ? `<img class="rbs-icon" src="${logo}" alt="" />`
    : `<div class="rbs-icon rbs-letter">${letter}</div>`;
  return `<div id="${BOOT_SPLASH_MARKER}" aria-hidden="true">${icon}</div>`;
}

function splashCss(): string {
  return `
#${BOOT_SPLASH_MARKER}{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:transparent;transition:opacity .35s ease;}
#${BOOT_SPLASH_MARKER}.rbs-out{opacity:0;pointer-events:none;}
#${BOOT_SPLASH_MARKER} .rbs-icon{width:96px;height:96px;object-fit:contain;border-radius:22px;transform-origin:center bottom;animation:rbs-bounce 1.1s cubic-bezier(.28,.84,.42,1) infinite;}
#${BOOT_SPLASH_MARKER} .rbs-letter{display:flex;align-items:center;justify-content:center;font-size:48px;font-weight:600;color:#fff;background:linear-gradient(160deg,#4aa8d8,#2f7fb8);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;}
@keyframes rbs-bounce{0%,100%{transform:translateY(0) scale(1,1);}12%{transform:translateY(0) scale(1.08,.92);}35%{transform:translateY(-34px) scale(.97,1.03);}55%{transform:translateY(0) scale(1.06,.94);}70%{transform:translateY(-10px) scale(1,1);}82%{transform:translateY(0) scale(1.02,.98);}}
@media (prefers-reduced-motion:reduce){#${BOOT_SPLASH_MARKER} .rbs-icon{animation:none;}}
`;
}

function splashScript(): string {
  return `<script>(function(){var el=document.getElementById('${BOOT_SPLASH_MARKER}');if(!el)return;var done=false;function hide(){if(done)return;done=true;el.classList.add('rbs-out');setTimeout(function(){el.remove();},400);}window.addEventListener('rosezm:first-frame',hide);if(typeof window.__rosezmFirstFrameMs==='number')hide();setTimeout(hide,3000);})();</script>`;
}

/** Inject the boot splash into every HTML document of a staged site.
 *  Idempotent. Returns the number of documents tagged. */
export async function injectBootSplash(site: string, opts: { logo?: string; letter?: string } = {}): Promise<number> {
  const letter = (opts.letter ?? 'D').slice(0, 1).toUpperCase();
  const style = `<style>${splashCss()}</style>`;
  const plate = splashHtml(letter, opts.logo) + splashScript();
  let tagged = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'target' || entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist')) continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(p); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const html = await fs.promises.readFile(p, 'utf8');
      if (html.includes(BOOT_SPLASH_MARKER)) continue;
      // style in <head> (paints with first byte of body), plate right after <body>.
      let next = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${style}</head>`) : style + html;
      next = /<body[^>]*>/i.test(next) ? next.replace(/<body[^>]*>/i, (m) => `${m}${plate}`) : plate + next;
      await fs.promises.writeFile(p, next, 'utf8');
      tagged++;
    }
  };
  await walk(site);
  return tagged;
}

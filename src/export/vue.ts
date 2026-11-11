/**
 * rosezm - the Vue 3 / Vite export (0.2.1).
 *
 * A `.rose` tree already leaves the framework as a built site; this target
 * wraps that site in a real Vue 3 single-file-component app instead of a
 * bare index.html. The Rose client still owns the DOM inside a full-bleed
 * <iframe> (the same boundary every WebView shell draws), while the Vue
 * layer owns the window chrome, the native capability bridge and the
 * `--api` connection. Vite builds it with `npm run build`; no Vue runtime
 * is vendored - `package.json` names the dependency.
 *
 * Output:
 *   vue/package.json          - Vue 3 + Vite, scripts dev/build/preview
 *   vue/vite.config.ts        - public/rosezm/ holds the baked site
 *   vue/tsconfig.json         - vue-tsc type-check config
 *   vue/index.html            - Vite entry
 *   vue/src/main.ts           - createApp(App).mount('#app')
 *   vue/src/App.vue           - full-bleed site frame + status bar
 *   vue/src/rosezm.ts         - typed useNative/--api bridge for the shell
 *   vue/public/rosezm/        - the baked site (one document per route)
 *   vue/README.md
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanRoseFiles, scanComponentFiles } from '../compiler/index.js';
import { nativeUsage } from './native-api.js';
import { keepOnlyExcept } from './fs-util.js';
import { bakeShellDocuments, pageNames, pruneServerBundle, stageBuiltSite, shellCapabilityGaps, writeShellBridge } from './desktop-shell.js';
import { appBuildNumber, appIdentity, type AppIdentity } from './app-identity.js';
import { writeDeployScaffold } from './deploy-scaffold.js';

const LABEL = 'vue';

export interface EmitVueOptions {
  projectRoot: string;
  outDir: string;
  apiBase?: string;
  warnings: string[];
}

export async function emitVue(opts: EmitVueOptions): Promise<{ pages: string[]; components: string[] }> {
  const out = path.join(opts.outDir, LABEL);
  await keepOnlyExcept(out, ['node_modules', 'dist']);
  await fs.promises.mkdir(path.join(out, 'src'), { recursive: true });

  const app = appIdentity(opts.projectRoot);
  const pageFiles = await scanRoseFiles(opts.projectRoot);
  const compFiles = await scanComponentFiles(opts.projectRoot);
  const native = nativeUsage(await Promise.all([...pageFiles, ...compFiles].map((f) => fs.promises.readFile(f, 'utf8'))));

  // The baked site MUST NOT sit at public/index.html: that path collides
  // with Vite's own root index.html entry on the build. A dedicated
  // subdirectory keeps both documents and makes the iframe URL explicit.
  const site = path.join(out, 'public', 'rosezm');
  await stageBuiltSite(opts.projectRoot, site, LABEL, opts.warnings);
  const docs = await bakeShellDocuments(pageFiles, site, LABEL, opts.warnings);
  await pruneServerBundle(site);
  await writeShellBridge(site, opts.apiBase ?? '', native, {
    id: app.id, name: app.name, version: app.version, build: appBuildNumber(app.version),
  });
  for (const gap of shellCapabilityGaps(native)) {
    opts.warnings.push(`${LABEL}: useNative('${gap}') is answered by the Vue bridge's null contract - the baked site owns the dynamic half`);
  }

  await fs.promises.writeFile(path.join(out, 'package.json'), renderPackage(app), 'utf8');
  await fs.promises.writeFile(path.join(out, 'vite.config.ts'), renderViteConfig(), 'utf8');
  await fs.promises.writeFile(path.join(out, 'tsconfig.json'), renderTsConfig(), 'utf8');
  await fs.promises.writeFile(path.join(out, 'index.html'), renderIndex(app), 'utf8');
  await fs.promises.writeFile(path.join(out, 'src', 'main.ts'), renderMain(), 'utf8');
  await fs.promises.writeFile(path.join(out, 'src', 'App.vue'), renderApp(app), 'utf8');
  await fs.promises.writeFile(path.join(out, 'src', 'rosezm.ts'), renderBridge(opts.apiBase ?? '', native), 'utf8');
  await fs.promises.writeFile(path.join(out, 'README.md'), renderReadme(opts.apiBase ?? '', docs.baked, app), 'utf8');
  await writeDeployScaffold('vue', out, opts.warnings);

  return {
    pages: pageNames(pageFiles),
    components: compFiles.map((f) => path.basename(f, '.rose')),
  };
}

function renderPackage(app: AppIdentity): string {
  return JSON.stringify({
    name: app.slug || 'rosezm-vue-app',
    version: app.version || '1.0.0',
    private: true,
    type: 'module',
    scripts: { dev: 'vite', build: 'vue-tsc -p tsconfig.json --noEmit && vite build', preview: 'vite preview' },
    dependencies: { vue: '^3.5.0' },
    devDependencies: { '@vitejs/plugin-vue': '^5.2.0', 'typescript': '^5.7.0', 'vite': '^6.0.0', 'vue-tsc': '^2.2.0' },
  }, null, 2) + '\n';
}

function renderTsConfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      lib: ['ES2022', 'DOM'],
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      types: ['vite/client'],
      jsx: 'preserve',
    },
    include: ['src/**/*.ts', 'src/**/*.vue', 'vite.config.ts'],
  }, null, 2) + '\n';
}

function renderViteConfig(): string {
  return `import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// The baked Rose site lives in public/rosezm/ (never public/index.html:
// that is Vite's own entry) and is copied verbatim to dist/rosezm/.
// Vite owns only the Vue shell (index.html + src/).
export default defineConfig({
  plugins: [vue()],
  publicDir: 'public',
  build: { outDir: 'dist', emptyOutDir: true },
});
`;
}

function renderIndex(app: AppIdentity): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${app.name || 'Rosezm'}</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`;
}

function renderMain(): string {
  return `import { createApp } from 'vue';
import App from './App.vue';

createApp(App).mount('#app');
`;
}

function renderApp(app: AppIdentity): string {
  return `<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { apiBase, nativeCalls } from './rosezm';

// The Rose client owns its own DOM inside the frame: this is the same
// boundary every WebView shell draws. Vue owns the window chrome only.
const ready = ref(false);
const frame = ref<HTMLIFrameElement | null>(null);
const label = ${JSON.stringify(app.name || 'Rosezm')};

onMounted(() => {
  if (frame.value) frame.value.src = '/rosezm/index.html';
  ready.value = true;
});
</script>

<template>
  <div class="rosezm-shell">
    <header class="rosezm-bar">
      <span class="rosezm-name">{{ label }}</span>
      <span class="rosezm-api">{{ apiBase || 'static build' }}</span>
      <span class="rosezm-native">{{ nativeCalls.length }} native capability(s)</span>
    </header>
    <iframe ref="frame" class="rosezm-frame" title="Rosezm app" @load="ready = true" />
  </div>
</template>

<style scoped>
.rosezm-shell { display: flex; flex-direction: column; height: 100vh; margin: 0; }
.rosezm-bar {
  display: flex; gap: 1rem; align-items: center; padding: 0.4rem 0.9rem;
  font: 12px/1.4 system-ui, sans-serif; background: #16181d; color: #e7e9ee;
}
.rosezm-name { font-weight: 600; }
.rosezm-api, .rosezm-native { opacity: 0.65; }
.rosezm-frame { flex: 1; border: 0; width: 100%; background: #fff; }
</style>
`;
}

function renderBridge(apiBase: string, native: string[]): string {
  return `// Generated by \`rosezm export vue\` - the Vue layer's typed surface.
// The baked site speaks the same bridge every shell ships (rosezm-shell.js).
export const apiBase = ${JSON.stringify(apiBase)};
export const nativeCalls = ${JSON.stringify(native)} as const;

export type NativeCapability = typeof nativeCalls[number];

/** Ask the shell for a native capability. The site's bridge answers null
 *  when the runtime has no implementation, matching useNative's contract. */
export function useNative<T = unknown>(capability: string, options: Record<string, unknown> = {}): Promise<T | null> {
  const win = window as unknown as {
    __rosezmNative?: (c: string, o: Record<string, unknown>) => Promise<T | null>;
  };
  if (typeof win.__rosezmNative !== 'function') return Promise.resolve(null);
  return win.__rosezmNative(capability, options);
}
`;
}

function renderReadme(apiBase: string, docs: number, app: AppIdentity): string {
  return `# ${app.name || 'Rosezm'} - Vue 3 shell

Generated by \`rosezm export vue\`. The baked Rose site (${docs} documents)
rides \`public/rosezm/\` and is served verbatim by Vite at \`/rosezm/\`; \`src/App.vue\` is the
full-bleed window chrome around it.

## Run

\`\`\`
cd vue
npm install
npm run dev      # Vite dev server
npm run build    # type-check + dist/
npm run preview
\`\`\`

The dynamic half (server actions, \`$data\`) rides the bridge to
\`${apiBase || 'the deployed Rose server (--api)'}\`; \`useNative(...)\`
is answered by \`src/rosezm.ts\` on the bridge's null contract.

Version ${app.version || '1.0.0'}.
`;
}

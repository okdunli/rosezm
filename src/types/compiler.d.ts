/// <reference types="node" />
/**
 * Types for `rosezm/compiler` - the programmatic compile surface a plugin or
 * a build tool drives: compileComponent, the config loaders, the file
 * scanners and the shared CSS scoper.
 *
 * Declared locally (they are build-time APIs, not runtime page APIs, and the
 * package-level rosezm.d.ts covers the page surface). BUG.md CE.
 */

export interface CompileResult {
  ssr: string;
  client: string;
  stateKeys: string[];
  actionNames: string[];
  guardName: string | null;
  style: string;
  hasParams: boolean;
  api?: string;
  apiMethods?: string[];
  hasPrerender?: boolean;
  usesContext?: boolean;
}

export interface Plugin {
  name: string;
  transform?: (code: string, filePath: string) => string | Promise<string> | { code: string; deps?: string[] } | Promise<{ code: string; deps?: string[] }>;
  deps?: string[];
  onRequest?: (request: Request) => Response | void | Promise<Response | void>;
  onServe?: (app: { store: unknown }) => void;
}

export declare function compileComponent(
  filePath: string,
  publicDir: string,
  scopeKey: string,
  isApi?: boolean,
  plugins?: Plugin[],
  registry?: Map<string, unknown>,
): Promise<CompileResult>;

export declare function loadConfig(root: string): Promise<{ plugins?: Plugin[]; watch?: string[]; [k: string]: unknown }>;
export declare function loadPlugins(root: string): Promise<Plugin[]>;
export declare function scanRoseFiles(root: string): Promise<string[]>;
export declare function scanComponentFiles(root: string): Promise<string[]>;
export declare function scopeCss(css: string, key: string, rootSel?: string): string;
export declare function extractExports(script: string): { clean: string; exports: string; actions: Array<{ name: string; stmt: string }>; props: Array<{ name: string; def: string | null }>; guard: string };
export declare class RoseError extends Error {
  code: string;
  hint?: string;
  constructor(code: string, message: string, detail?: { hint?: string; file?: string });
}

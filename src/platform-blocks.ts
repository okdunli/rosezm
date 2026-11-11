/**
 * Conditional compilation: `{#ifdef target}{:else}{/ifdef}` and `{#ifndef target}`.
 *
 * Why this lives at the root and not inside `export/`: the WEB compiler has its
 * own parser and must not import export code (that would make the framework's own
 * build depend on the export path). Both pipelines - `compiler/index.ts` and
 * `export/ir.ts` - import this one leaf, so one implementation serves all 14
 * targets and the web build agrees with them.
 *
 * The block is resolved as TEXT, before any parser sees the source: the branch
 * that loses is deleted outright, so no emitter has to implement the feature and
 * none of them can drift from the others.
 */

/** A target name or family a `{#ifdef}` may name. */
const PLATFORM_TERMS: Record<string, string[]> = {
  'mini-program': ['weapp', 'qq', 'alipay', 'baidu', 'toutiao'],
  miniprogram: ['weapp', 'qq', 'alipay', 'baidu', 'toutiao'],
  native: ['flutter', 'android', 'arkts', 'xcode'],
  desktop: ['electron', 'python', 'dotnet', 'java', 'cpp'],
  web: ['web'],
};
const PLATFORM_NAMES = new Set([
  'weapp', 'qq', 'alipay', 'baidu', 'toutiao', 'flutter', 'android', 'arkts',
  'xcode', 'electron', 'python', 'dotnet', 'java', 'cpp', 'web', 'vue',
]);

/** The uni-app spellings, so code migrating from it keeps working - these
 *  are the names an author already has in their `// #ifdef MP-WEIXIN` markers. */
const UNI_APP_ALIASES: Record<string, string> = {
  'mp-weixin': 'weapp', 'mp-qq': 'qq', 'mp-alipay': 'alipay',
  'mp-baidu': 'baidu', 'mp-toutiao': 'toutiao',
};

/** True when `platform` is covered by the `{#ifdef}` term `want`. */
export function platformSatisfies(want: string, platform: string): boolean {
  const me = platform.toLowerCase();
  const term = want.trim().toLowerCase();
  const resolved = UNI_APP_ALIASES[term] ?? term;
  const group = PLATFORM_TERMS[resolved];
  if (group) return group.includes(me);
  return resolved === me;
}

/** An unknown spelling is worth naming; naming another platform is not - it is
 *  simply false for this build, which is the whole point of the block. */
export function platformTermIsKnown(want: string): boolean {
  const term = want.trim().toLowerCase();
  if (UNI_APP_ALIASES[term]) return true;
  return PLATFORM_TERMS[term] !== undefined || PLATFORM_NAMES.has(term);
}

export function resolvePlatformBlocks(src: string, platform = 'web', warnings: string[] = []): string {
  return resolveCommentBlocks(resolveBraceBlocks(src, platform, warnings), platform, warnings);
}

/**
 * The comment form uni-app made famous, for `<script>` and `<style>`:
 *
 *   // #ifdef MP-WEIXIN
 *   ...JS or CSS...
 *   // #endif
 *
 * A `<style>` block uses the same markers (CSS has no `//`, but the marker is
 * what the author writes, so it is accepted in both). Blocks nest and an
 * `#ifndef` inverts the test; a losing branch is deleted outright.
 */
export function resolveCommentBlocks(src: string, platform = 'web', warnings: string[] = []): string {  const re = /^[ \t]*(?:\/\/|<!--|\/\*)\s*#(ifdef|ifndef|endif)\b([ \t\S]*?)(?:\*\/|-->)?[ \t]*$/gm;
  const lines = src.split('\n');
  const out: string[] = [];
  // Stack of "is this level currently emitting" flags.
  const stack: boolean[] = [];
  const emitting = (): boolean => stack.every(Boolean);
  for (const line of lines) {
    const m = re.exec(line);
    re.lastIndex = 0;
    if (m) {
      const kind = m[1];
      const want = (m[2] ?? '').trim().split(/\s+/)[0].toLowerCase();
      if (kind === 'endif') {
        if (!stack.length) warnings.push(`#endif with no matching #ifdef - left as written`);
        else stack.pop();
        continue;
      }
      if (!platformTermIsKnown(want)) {
        warnings.push(`#${kind} ${want} names an unknown target or family - treated as false`);
      }
      const hit = platformSatisfies(want, platform);
      stack.push(kind === 'ifdef' ? hit : !hit);
      continue;
    }
    if (emitting()) out.push(line);
  }
  if (stack.length) warnings.push(`${stack.length} #ifdef without #endif - the tail is kept as written`);
  return out.join('\n');
}
/** The template form: `{#ifdef target}{:else}{/ifdef}`. */
export function resolveBraceBlocks(src: string, platform = 'web', warnings: string[] = []): string {
  const me = platform.toLowerCase();
  let out = src;
  for (let pass = 0; pass < 40; pass++) {
    const open = /\{#(ifdef|ifndef)\s+([^}]*)\}/.exec(out);
    if (!open) break;
    const kind = open[1];
    const want = open[2].trim().toLowerCase();
    const hit = platformSatisfies(want, me);
    const keep = kind === 'ifdef' ? hit : !hit;
    if (!platformTermIsKnown(want)) {
      warnings.push(`{#${kind} ${want}} names an unknown target or family - treated as false`);
    }
    // Walk to this block's closer, honouring nesting and the {:else} split.
    let i = open.index + open[0].length;
    let depth = 1;
    let elseAt = -1;
    let closeAt = -1;
    const re = /\{#(ifdef|ifndef)\b|\{:(else)\b|\{\/(ifdef|ifndef)\}/g;
    re.lastIndex = i;
    for (let m = re.exec(out); m; m = re.exec(out)) {
      if (m[1]) depth++;
      else if (m[3]) {
        depth--;
        if (depth === 0) { closeAt = m.index; break; }
      } else if (m[2] && depth === 1) elseAt = m.index;
    }
    if (closeAt < 0) { warnings.push(`{#${kind} ${want}} has no {/${kind}} - left as written`); break; }
    const elseEnd = elseAt >= 0 ? elseAt + '{:else}'.length : closeAt;
    const taken = elseAt >= 0
      ? (keep ? out.slice(i, elseAt) : out.slice(elseEnd, closeAt))
      : (keep ? out.slice(i, closeAt) : '');
    out = out.slice(0, open.index) + taken + out.slice(closeAt + kind.length + 3);
  }
  return out;
}

/// <reference types="node" />
/**
 * Types for `rosezm/export` - the universal export surface: the target
 * registry, the per-target status, and exportProject itself.
 *
 * BUG.md CE: without these, `import { exportProject } from "rosezm/export"`
 * in a downstream TypeScript project reported TS7016 (implicit any).
 */

export type TargetStatus = 'ready' | 'planned';

export interface TargetInfo {
  name: string;
  family: 'mini-program' | 'native' | 'desktop' | 'web';
  dir: string;
  status: TargetStatus;
  summary: string;
}

export declare const TARGETS: Record<string, TargetInfo>;

export declare function targetList(): Array<{ id: string; name: string; family: string; status: TargetStatus; summary: string }>;

export declare function isTarget(id: string): boolean;

export interface ExportResult {
  target: string;
  outDir: string;
  pages: number;
  components: number;
  warnings: string[];
}

export declare function exportProject(
  projectRoot: string,
  opts?: { target?: string; outDir?: string; apiBase?: string },
): Promise<ExportResult>;

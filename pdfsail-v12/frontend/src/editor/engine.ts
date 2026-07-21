import type { Block } from "./types";

export interface EditorEngine {
  getAll(): Block[];
}

export function addBlock(
  blocks: Block[],
  block: Block
): Block[] {
  return [...blocks, block];
}

export function updateBlock(
  blocks: Block[],
  id: string,
  patch: Partial<Block>
): Block[] {
  return blocks.map((b) => (b.id === id ? { ...b, ...patch } as Block : b));
}

export function deleteBlock(blocks: Block[], id: string): Block[] {
  return blocks.filter((b) => b.id !== id);
}

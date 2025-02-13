import { join } from 'path';
import { readFile, writeFile } from 'node:fs/promises';
import { ensureHumeDir } from './common';

export interface GenerationHistory {
  ids: string[];
  timestamp: number;
}

export async function getLastSynthesisFromHistory(): Promise<GenerationHistory | null> {
  try {
    const humeDir = await ensureHumeDir();
    const lastGenPath = join(humeDir, 'last_generation.json');
    const data = await readFile(lastGenPath, 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export async function saveLastSynthesisToHistory(generation: GenerationHistory): Promise<void> {
  const humeDir = await ensureHumeDir();
  const lastGenPath = join(humeDir, 'last_generation.json');
  await writeFile(lastGenPath, JSON.stringify(generation));
}

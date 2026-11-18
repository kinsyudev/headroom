import { join } from 'node:path';
import { buildUi, type Asset } from './http';

export function loadUi(): Promise<Map<string, Asset>> {
  return buildUi(join(import.meta.dir, '../ui/index.html'));
}

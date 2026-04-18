import { Tag } from '../../types/store';
import { getSettings, updateSettings } from './settingsService';

const SYSTEM_TAGS: Tag[] = [
  { id: 'admin', name: 'Admin', color: '#dc2626', icon: 'fa-user-shield', type: 'system', locked: true },
  { id: 'autorefresh', name: 'autorefresh', color: '#10b981', icon: 'fa-sync-alt', type: 'system', locked: true },
  { id: 'cookie-import', name: 'Cookie-Import', color: '#ea580c', icon: 'fa-cookie-bite', type: 'system', locked: true },
  { id: 'credential', name: 'Credential', color: '#475569', icon: 'fa-key', type: 'system', locked: true },
  { id: 'detached', name: 'Detached', color: '#9ca3af', icon: 'fa-unlink', type: 'system', locked: true },
];

export async function getSystemTags(): Promise<Tag[]> {
  // Filter out legacy dummy tags that should no longer appear
  return SYSTEM_TAGS.filter(tag => tag.id !== 'production' && tag.id !== 'backup');
}

export async function getUserTags(): Promise<Tag[]> {
  const settings = await getSettings();
  // Ensure userTags is an array
  return Array.isArray(settings.tags?.userTags) ? settings.tags.userTags : [];
}

async function saveUserTags(tags: Tag[]) {
  const settings = await getSettings();
  await updateSettings({
    ...settings,
    tags: { ...settings.tags, userTags: tags },
  });
}

export async function createUserTag(tag: Omit<Tag, 'id' | 'type'>) {
  const userTags = await getUserTags();
  const newTag: Tag = {
    ...tag,
    id: crypto.randomUUID(),
    type: 'user',
  };
  const updated = [...userTags, newTag];
  await saveUserTags(updated);
  return newTag;
}

export async function updateUserTag(id: string, updates: Partial<Omit<Tag, 'id' | 'type'>>) {
  const userTags = await getUserTags();
  const index = userTags.findIndex(t => t.id === id);
  if (index === -1) throw new Error('Tag not found');
  const updated = [...userTags];
  updated[index] = { ...updated[index], ...updates };
  await saveUserTags(updated);
  return updated[index];
}

export async function deleteUserTag(id: string) {
  const userTags = await getUserTags();
  const updated = userTags.filter(t => t.id !== id);
  await saveUserTags(updated);
}

export async function getTagCounts(_accountIds?: string[]): Promise<Record<string, number>> {
  // This would require accounts data; we'll implement later.
  // For now return empty.
  return {};
}

export { SYSTEM_TAGS };
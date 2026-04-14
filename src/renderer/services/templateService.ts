const STORE_KEY = 'emailTemplates';

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  type: 'html' | 'plain';
  createdAt: string;
  updatedAt: string;
}

export async function getTemplates(): Promise<EmailTemplate[]> {
  const data = await window.electron.store.get(STORE_KEY);
  return Array.isArray(data) ? data : [];
}

async function save(templates: EmailTemplate[]) {
  await window.electron.store.set(STORE_KEY, templates);
}

export async function addTemplate(
  t: Omit<EmailTemplate, 'id' | 'createdAt' | 'updatedAt'>
): Promise<EmailTemplate> {
  const all = await getTemplates();
  const now = new Date().toISOString();
  const entry: EmailTemplate = { ...t, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
  all.push(entry);
  await save(all);
  return entry;
}

export async function updateTemplate(
  id: string,
  updates: Partial<EmailTemplate>
): Promise<EmailTemplate> {
  const all = await getTemplates();
  const idx = all.findIndex(t => t.id === id);
  if (idx === -1) throw new Error('Template not found');
  all[idx] = { ...all[idx], ...updates, updatedAt: new Date().toISOString() };
  await save(all);
  return all[idx];
}

export async function deleteTemplate(id: string): Promise<void> {
  const all = await getTemplates();
  await save(all.filter(t => t.id !== id));
}

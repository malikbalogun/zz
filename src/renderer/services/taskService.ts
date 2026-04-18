import type { FollowUpTask } from '../../types/store';

const STORE_KEY = 'followUpTasks';

export async function getTasks(): Promise<FollowUpTask[]> {
  const data = await window.electron.store.get(STORE_KEY);
  return Array.isArray(data) ? data : [];
}

async function saveTasks(tasks: FollowUpTask[]) {
  await window.electron.store.set(STORE_KEY, tasks);
}

export async function addTask(
  task: Omit<FollowUpTask, 'id' | 'createdAt' | 'updatedAt'>
): Promise<FollowUpTask> {
  const tasks = await getTasks();
  const now = new Date().toISOString();
  const entry: FollowUpTask = {
    ...task,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
  tasks.push(entry);
  await saveTasks(tasks);
  return entry;
}

export async function updateTask(
  id: string,
  updates: Partial<FollowUpTask>
): Promise<FollowUpTask> {
  const tasks = await getTasks();
  const idx = tasks.findIndex(t => t.id === id);
  if (idx === -1) throw new Error('Task not found');
  tasks[idx] = { ...tasks[idx], ...updates, updatedAt: new Date().toISOString() };
  await saveTasks(tasks);
  return tasks[idx];
}

export async function deleteTask(id: string): Promise<void> {
  const tasks = await getTasks();
  await saveTasks(tasks.filter(t => t.id !== id));
}

export async function completeTask(id: string): Promise<FollowUpTask> {
  return updateTask(id, { status: 'done' });
}

export async function createTaskFromEmail(
  accountId: string,
  emailId: string,
  emailSubject: string,
  title?: string
): Promise<FollowUpTask> {
  return addTask({
    title: title || `Follow-up: ${emailSubject}`,
    description: `Linked to email: ${emailSubject}`,
    status: 'pending',
    accountId,
    emailId,
    emailSubject,
  });
}

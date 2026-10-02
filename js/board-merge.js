const fields = {
  notes: ['title', 'content'],
  checklists: ['title', 'goal'],
  tasks: ['text', 'done', 'kind', 'answer', 'checklistId'],
};

function conflict(id) {
  throw Object.assign(new Error(`${id}: 다른 곳에서도 같은 항목을 수정했습니다. 입력 내용은 이 기기에 보관됩니다.`), { code: 'BOARD_CONFLICT' });
}

// Merge independent edits only. Never silently replace a concurrent edit or deletion.
export function mergeBoardChanges(base, local, remote) {
  const result = structuredClone(remote);
  for (const [collection, keys] of Object.entries(fields)) {
    const before = new Map(base[collection].map(item => [item.id, item]));
    const after = new Map(local[collection].map(item => [item.id, item]));
    const current = new Map(result[collection].map(item => [item.id, item]));
    const changed = (a, b) => keys.some(key => a[key] !== b[key]);
    for (const [id, previous] of before) {
      if (after.has(id)) continue;
      const existing = current.get(id);
      if (existing && changed(previous, existing)) conflict(id);
      // Removing a list must not silently delete a question added by another client.
      if (collection === 'checklists' && remote.tasks.some(task => task.checklistId === id
        && !base.tasks.some(old => old.id === task.id))) conflict(id);
      current.delete(id);
    }
    for (const [id, item] of after) {
      const previous = before.get(id);
      const existing = current.get(id);
      if (!previous) {
        if (existing && (changed(item, existing) || item.createdAt !== existing.createdAt)) conflict(id);
        if (!existing) current.set(id, structuredClone(item));
        continue;
      }
      if (!changed(previous, item)) continue;
      if (!existing) conflict(id);
      for (const key of keys) {
        if (previous[key] === item[key]) continue;
        if (existing[key] !== previous[key] && existing[key] !== item[key]) conflict(id);
        existing[key] = item[key];
      }
      existing.updatedAt = Math.max(item.updatedAt || 0, existing.updatedAt || 0);
    }
    result[collection] = [...current.values()];
  }
  for (const key of ['nextTaskNumber', 'nextNoteNumber', 'nextChecklistNumber']) {
    result[key] = Math.max(local[key], remote[key]);
  }
  if (result.tasks.some(task => !result.checklists.some(list => list.id === task.checklistId))) conflict('체크리스트');
  return result;
}

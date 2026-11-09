export type EditorContextMenuKind = 'body' | 'table' | 'object' | 'field';

/** Registry IDs are shared with the menubar, toolbar, and command palette. */
export function contextMenuCommandGroups(kind: EditorContextMenuKind): readonly (readonly string[])[] {
  if (kind === 'object') return [['edit.undo'], ['object.edit-properties', 'object.rotate', 'object.flip-horizontal', 'object.flip-vertical', 'object.caption-toggle'],
    ['object.z-front', 'object.z-forward', 'object.z-backward', 'object.z-back', 'object.z-in-front-of-text', 'object.z-behind-text'], ['object.group', 'object.ungroup'], ['object.delete']];
  if (kind === 'table') return [['edit.undo', 'edit.cut', 'edit.copy', 'edit.paste'],
    ['table.insert-row-above', 'table.insert-row-below', 'table.delete-row'],
    ['table.insert-column-left', 'table.insert-column-right', 'table.delete-column'],
    ['table.merge-cells', 'table.split-cell', 'table.cell-properties'],
    ['table.formula', 'table.block-sum', 'table.block-average', 'table.block-product'],
    ['table.equalize-widths', 'table.equalize-heights', 'table.transpose', 'table.split-table', 'table.merge-next', 'table.delete', 'table.caption-toggle'], ['insert.clickhere-field']];
  if (kind === 'field') return [['edit.undo', 'edit.cut', 'edit.copy', 'edit.paste'], ['field.edit', 'field.remove'], ['view.form-mode']];
  return [['edit.undo', 'edit.cut', 'edit.copy', 'edit.paste'], ['insert.paragraph', 'insert.table', 'insert.clickhere-field', 'insert.page-break'], ['tool.find']];
}

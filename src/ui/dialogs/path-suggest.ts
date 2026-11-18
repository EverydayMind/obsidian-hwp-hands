/** Extracts the normalized folder portion of a vault path for filtering folder suggestions. */
export function pathFolderQuery(currentPath: string): string {
  const normalized = currentPath.replaceAll('\\', '/').replace(/^\/+/, '');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(0, slash).trim().toLowerCase() : '';
}

/** Filters and ranks vault folder paths matching the folder portion of `currentPath`. */
export function filterFolderSuggestions(folders: readonly string[], currentPath: string): string[] {
  const query = pathFolderQuery(currentPath);
  const unique = [...new Set(folders.map(folder => folder.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')).filter(Boolean))];
  const sorted = unique.sort((a, b) => a.localeCompare(b));
  if (!query) return sorted;
  const starts: string[] = [];
  const contains: string[] = [];
  for (const folder of sorted) {
    const lower = folder.toLowerCase();
    if (lower.startsWith(query)) starts.push(folder);
    else if (lower.includes(query)) contains.push(folder);
  }
  return [...starts, ...contains];
}

/** Replaces only the folder portion of `currentPath` with `folder`, preserving the file name. */
export function replaceFolderInPath(currentPath: string, folder: string): string {
  const normalizedPath = currentPath.replaceAll('\\', '/');
  const slash = normalizedPath.lastIndexOf('/');
  const fileName = slash >= 0 ? normalizedPath.slice(slash + 1) : normalizedPath.replace(/^\/+/, '');
  const cleanFolder = folder.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  return cleanFolder ? `${cleanFolder}/${fileName}` : fileName;
}

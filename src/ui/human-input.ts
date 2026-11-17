export function commandDisplayName(name: string): string {
  return name.replace(/^(?:HWP Hands: |HWP: )/, '');
}

export function newDocumentPath(path: string): string {
  const basename = path.slice(path.lastIndexOf('/') + 1);
  return basename && !basename.includes('.') ? `${path}.hwpx` : path;
}

import { moment } from 'obsidian';
import { initLocale } from './locale';
// Evaluate before the UI catalogs. Obsidian reloads when its language changes.
initLocale(() => moment.locale());

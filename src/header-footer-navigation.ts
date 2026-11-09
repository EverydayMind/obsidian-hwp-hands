import type { HeaderFooterAddress, PageInfo } from './api';

export function headerFooterPageApplies(address: HeaderFooterAddress, page: Pick<PageInfo, 'pageIndex' | 'pageNumber' | 'sectionIndex'>): boolean {
  if (page.sectionIndex !== address.section) return false;
  if (address.applyTo === 0) return true;
  const number = Number.isSafeInteger(page.pageNumber) && page.pageNumber > 0 ? page.pageNumber : page.pageIndex + 1;
  return address.applyTo === 1 ? number % 2 === 0 : address.applyTo === 2 && number % 2 === 1;
}

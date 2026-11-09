import { HwpHandsError, type DocumentObject, type Json, type ObjectResource } from '../api';

export interface ImageInspection {
  findings: Array<{ [key: string]: Json }>;
  scanned: number;
  pictures: number;
  unchecked: number;
  complete: boolean;
  objectCount: number;
  objectTotal: number;
}

/** Check actual resource bytes internally; neither bytes nor engine exception text leave this function.
 * A failed getter is inconclusive, not evidence that an image is absent or that a file is corrupt.
 */
export async function inspectImages(objects: DocumentObject[], total: number, epoch: string,
  load: (object: DocumentObject) => Promise<ObjectResource>, signal?: AbortSignal): Promise<ImageInspection> {
  const pictures = objects.map((object, index) => ({ object, index })).filter(({ object }) => object.kind === 'picture');
  const findings: ImageInspection['findings'] = [];
  let scanned = 0, unchecked = 0;
  for (const { object, index } of pictures.slice(0, 40)) {
    if (signal?.aborted) throw new HwpHandsError('CANCELLED', '그림 점검이 취소됐다.');
    let empty = false;
    try { empty = (await load(object)).bytes.length === 0; }
    catch (error) {
      if (error instanceof HwpHandsError && ['REVISION_CONFLICT', 'CANCELLED', 'CLOSED'].includes(error.code)) throw error;
      unchecked++;
      findings.push({ code: 'image_resource_unavailable', severity: 'warning', handle: `${epoch}:o${index + 1}`,
        context: '그림 리소스를 조회하지 못했다. 누락 여부는 미확인이다.',
        suggest: '사람이 해당 그림을 화면에서 확인하라. 조회 실패만으로 그림을 삭제하거나 다시 만들지 마라.' });
    }
    scanned++;
    if (empty) findings.push({ code: 'missing_image', severity: 'warning', handle: `${epoch}:o${index + 1}`,
      context: '그림 리소스가 비어 있다.', suggest: '사람이 그림 원본과 화면을 확인한 뒤 복구 여부를 결정해야 한다.' });
  }
  if (signal?.aborted) throw new HwpHandsError('CANCELLED', '그림 점검이 취소됐다.');
  unchecked += pictures.length - scanned;
  return { findings, scanned, pictures: pictures.length, unchecked, complete: objects.length === total && unchecked === 0,
    objectCount: objects.length, objectTotal: total };
}

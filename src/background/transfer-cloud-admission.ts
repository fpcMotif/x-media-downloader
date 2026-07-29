import type { TransferRequest } from '../core/download/transfer-registry'
import type { CloudUploadIntent } from './cloud-upload'

export const cloudUploadIntentsFor = (
  requests: readonly TransferRequest[],
): readonly CloudUploadIntent[] =>
  requests.flatMap((request) => {
    const item = request.item
    return item === undefined
      ? []
      : [
          {
            requestId: request.id,
            legacyAliases: [item.id],
            source: { url: item.url, ext: item.ext },
            filename: request.filename,
          },
        ]
  })

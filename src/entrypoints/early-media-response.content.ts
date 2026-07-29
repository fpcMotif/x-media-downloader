import { allPlatformHostMatch } from '../core/adapters/catalog'
import { installEarlyMediaResponseBridge } from './overlay.content/early-media-response'

/** Register the ISOLATED-world tee listener before either page code or overlay UI runs. */
export default defineContentScript({
  matches: [...allPlatformHostMatch()],
  runAt: 'document_start',
  main() {
    installEarlyMediaResponseBridge(document)
  },
})

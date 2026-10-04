import { t } from 'src/locales';
import { CONFIG } from 'src/global-config';

import { NotFoundView } from 'src/sections/error';

// ----------------------------------------------------------------------

const metadata = { title: `404 ${t.common.shell.notFound.title} | ${CONFIG.appName}` };

export default function Page() {
  return (
    <>
      <title>{metadata.title}</title>

      <NotFoundView />
    </>
  );
}

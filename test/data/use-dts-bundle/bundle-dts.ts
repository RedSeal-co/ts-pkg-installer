/// <reference path="typings/dts-bundle/dts-bundle.d.ts"/>

import dts = require('dts-bundle');

dts.bundle({
  name: 'use-dts-bundle',
  main: 'public.d.ts',
  out: 'index.d.ts',
  externals: false
});

/// <reference path="typings/bluebird/bluebird.d.ts"/>

'use strict';

import P = require('bluebird');

export function foo(): P<void> {
  return P.resolve();
}

export function bar(): P<void> {
  return P.resolve();
}
